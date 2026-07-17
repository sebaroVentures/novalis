//! Microphone capture (desktop only) via `cpal`.
//!
//! `cpal`'s `Stream` is `!Send`, so it can never live in Tauri-managed state or
//! cross an await point. Instead a dedicated OS thread owns the stream for its
//! whole life: it builds + plays the input stream, the audio callback *streams*
//! every captured sample straight to a raw f32 spill file on disk (never an
//! unbounded in-RAM buffer), and the thread parks on a stop channel. The
//! module-level [`RECORDER`] holds only the `Send` control handle (a stop sender,
//! the thread's `JoinHandle`, and the spill path), so no `!Send` value ever
//! escapes. Resident memory during capture is bounded by the `BufWriter` buffer,
//! independent of recording length — a multi-hour meeting no longer risks OOM.
//!
//! On stop we downmix to mono and resample to 16 kHz — the rate whisper expects —
//! by *streaming* the spill file through the DSP (never materializing the whole
//! recording), and write a 16-bit PCM WAV artifact under the app-data dir. The
//! finalize (join + resample + encode) runs off the async runtime in the caller's
//! `spawn_blocking`, so the main thread never freezes on Stop. The pure DSP
//! helpers ([`downmix_to_mono`], [`resample_linear`]) and the WAV round-trip are
//! unit-tested, and the streaming finalize is proven bit-identical to that path;
//! real device capture is exercised out-of-band (no mic in CI).
//!
//! ## macOS permission reality
//! Building the input stream fails loudly here when no input device exists or the
//! OS denies mic access, so [`start`] surfaces a clear error rather than silently
//! recording nothing. The bundle's `NSMicrophoneUsageDescription` (see
//! `src-tauri/Info.plist`) is what lets macOS show the permission prompt at all;
//! without it the first capture attempt is denied by TCC.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Sample, SampleFormat};

use crate::engine::CommandError;

/// whisper.cpp consumes 16 kHz mono f32 audio; we capture at the device's native
/// rate/format and normalize to this before writing the WAV.
pub const TARGET_RATE: u32 = 16_000;

/// The single in-progress recording, or `None`. Holds only `Send` control state;
/// the `!Send` `cpal::Stream` stays on the capture thread.
static RECORDER: Mutex<Option<Recorder>> = Mutex::new(None);

/// The `Send` control handle for the capture thread.
struct Recorder {
    /// Sending `()` (or dropping) tells the thread to stop and finalize.
    stop_tx: mpsc::Sender<()>,
    /// Yields the device config once all samples are flushed to the spill file.
    join: JoinHandle<Result<CaptureMeta, String>>,
    /// The raw interleaved-f32 spill file the capture thread streams to. Read by
    /// [`stop`] to finalize, and deleted by both [`stop`] and [`cancel`] so no
    /// scratch file is ever left behind (and none becomes a WAV on cancel).
    spill_path: PathBuf,
}

/// Device config the thread reports back once capture has fully flushed. The
/// audio itself lives in the spill file, not in memory.
struct CaptureMeta {
    sample_rate: u32,
    channels: u16,
}

/// A finalized recording written to disk.
pub struct Recording {
    pub path: PathBuf,
    pub duration_secs: f64,
}

fn err(kind: &str, msg: impl Into<String>) -> CommandError {
    CommandError {
        kind: kind.to_string(),
        message: msg.into(),
    }
}

/// Start capturing the default input device. Blocks only until the stream is
/// built and playing (or has failed), so a missing device / denied permission
/// is reported synchronously — never after the UI already shows "recording".
pub fn start() -> Result<(), CommandError> {
    let mut guard = RECORDER.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_some() {
        return Err(err("voiceBusy", "a recording is already in progress"));
    }

    // The thread signals readiness (or a build failure) back through `ready_tx`
    // so `start` can fail loud before returning.
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    // Stream captured samples to a raw-f32 scratch file in the temp dir; it is
    // finalized into the real WAV on stop and deleted on both stop and cancel.
    let spill_path =
        std::env::temp_dir().join(format!("novalis-voice-spill-{}.f32", uuid::Uuid::new_v4()));

    let thread_spill = spill_path.clone();
    let join = std::thread::Builder::new()
        .name("voice-capture".into())
        .spawn(move || capture_thread(ready_tx, stop_rx, thread_spill))
        .map_err(|e| {
            err(
                "voiceCapture",
                format!("cannot start the capture thread: {e}"),
            )
        })?;

    match ready_rx.recv() {
        Ok(Ok(())) => {
            *guard = Some(Recorder {
                stop_tx,
                join,
                spill_path,
            });
            Ok(())
        }
        // The thread failed to open the mic; join it to reclaim the error and
        // remove any partially-created spill file.
        Ok(Err(msg)) => {
            let _ = join.join();
            let _ = std::fs::remove_file(&spill_path);
            Err(err("voiceCapture", msg))
        }
        Err(_) => {
            let _ = join.join();
            let _ = std::fs::remove_file(&spill_path);
            Err(err(
                "voiceCapture",
                "the capture thread exited before starting",
            ))
        }
    }
}

/// Whether a capture is currently in progress (the startup sweep's guard).
pub fn is_recording() -> bool {
    RECORDER.lock().unwrap_or_else(|e| e.into_inner()).is_some()
}

/// Cancel the in-progress recording, discarding the captured samples without
/// ever writing them to disk (a true discard — no WAV artifact is left behind).
/// Fails loud when nothing is recording.
pub fn cancel() -> Result<(), CommandError> {
    let recorder = {
        let mut guard = RECORDER.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .take()
            .ok_or_else(|| err("voiceNotRecording", "no recording is in progress"))?
    };

    // Stop the thread and discard the spill file — no WAV artifact is ever
    // written, so a cancelled take leaves nothing behind.
    let _ = recorder.stop_tx.send(());
    let _ = recorder.join.join();
    let _ = std::fs::remove_file(&recorder.spill_path);
    Ok(())
}

/// Stop the in-progress recording, normalize it to 16 kHz mono, and write a
/// 16-bit PCM WAV to `out_path`. Fails loud when nothing is recording or no
/// audio was captured (muted mic / denied permission).
///
/// This joins the capture thread (which flushes the spill file first), then
/// streams that file through the downmix/resample DSP straight into the WAV
/// encoder — the whole recording is never held in memory at once. It is blocking
/// (join + resample + encode) and MUST be run off the async runtime by the caller
/// (`spawn_blocking`) so the UI thread never freezes on Stop.
pub fn stop(out_path: &Path) -> Result<Recording, CommandError> {
    let recorder = {
        let mut guard = RECORDER.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .take()
            .ok_or_else(|| err("voiceNotRecording", "no recording is in progress"))?
    };

    // Tell the thread to stop (a dropped sender would also do it); its join
    // completes only after every buffered sample is flushed to the spill file,
    // so the finalize below can safely read it without racing the callback.
    let _ = recorder.stop_tx.send(());
    let join_res = recorder.join.join();
    let spill = recorder.spill_path;

    // Finalize, then always remove the spill file (success or failure alike).
    let result = (|| {
        let meta = join_res
            .map_err(|_| err("voiceCapture", "the capture thread panicked"))?
            .map_err(|msg| err("voiceCapture", msg))?;
        finalize(&spill, &meta, out_path)
    })();
    let _ = std::fs::remove_file(&spill);
    result
}

/// Turn a flushed spill file into the 16 kHz mono WAV, streaming so peak memory
/// stays bounded regardless of recording length.
fn finalize(spill: &Path, meta: &CaptureMeta, out_path: &Path) -> Result<Recording, CommandError> {
    let len = std::fs::metadata(spill)
        .map_err(|e| {
            err(
                "voiceCapture",
                format!("cannot read the recording buffer: {e}"),
            )
        })?
        .len();
    // The spill holds raw little-endian f32 samples (4 bytes each).
    if len < 4 {
        return Err(err(
            "voiceEmpty",
            "no audio was captured — is the microphone muted or was permission denied?",
        ));
    }

    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            err(
                "voiceCapture",
                format!("cannot create the recording dir: {e}"),
            )
        })?;
    }

    let out_samples =
        stream_spill_to_wav_16k_mono(spill, meta.channels, meta.sample_rate, out_path)
            .map_err(|e| err("voiceCapture", format!("cannot write the recording: {e}")))?;

    Ok(Recording {
        path: out_path.to_path_buf(),
        duration_secs: out_samples as f64 / TARGET_RATE as f64,
    })
}

/// Owns the `!Send` stream for its whole life. Builds + plays the input stream,
/// signals readiness, parks until stopped, then flushes the spill file and
/// returns the device config.
fn capture_thread(
    ready_tx: mpsc::Sender<Result<(), String>>,
    stop_rx: mpsc::Receiver<()>,
    spill_path: PathBuf,
) -> Result<CaptureMeta, String> {
    // Build everything inside a closure so any failure is one `?`-chain we can
    // report through `ready_tx`. The `Stream` never leaves this thread.
    let built = build_stream(&spill_path);
    match built {
        Err(e) => {
            let _ = ready_tx.send(Err(e.clone()));
            Err(e)
        }
        Ok((stream, writer, write_failed, sample_rate, channels)) => {
            if let Err(e) = stream
                .play()
                .map_err(|e| format!("cannot start the microphone: {e}"))
            {
                let _ = ready_tx.send(Err(e.clone()));
                return Err(e);
            }
            let _ = ready_tx.send(Ok(()));
            // Park until stop (or the sender is dropped).
            let _ = stop_rx.recv();
            // Dropping the stream ends the callback (releasing its writer clone),
            // so we can flush + close the spill file with no more writes racing.
            drop(stream);
            {
                let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
                w.flush()
                    .map_err(|e| format!("cannot flush the recording buffer: {e}"))?;
            }
            // The callback can't propagate a write error inline, so it latches
            // one here; surface it loudly rather than finalizing a truncated take.
            if write_failed.load(Ordering::Relaxed) {
                return Err("failed to write captured audio to disk".to_string());
            }
            Ok(CaptureMeta {
                sample_rate,
                channels,
            })
        }
    }
}

/// A spill writer shared with the audio callback: a buffered handle to the raw
/// f32 file plus a latch the callback flips if a write ever fails.
type SpillWriter = Arc<Mutex<BufWriter<File>>>;

/// Append an interleaved f32 slice to the spill file as raw little-endian bytes.
/// A single lock + buffered writes keeps this cheap; back-pressure (a stalled
/// disk blocks the callback) is preferred over ever dropping a sample.
fn spill_samples(writer: &SpillWriter, write_failed: &AtomicBool, data: &[f32]) {
    let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
    for &s in data {
        if let Err(e) = w.write_all(&s.to_le_bytes()) {
            if !write_failed.swap(true, Ordering::Relaxed) {
                log::error!("voice capture: cannot write sample to spill file: {e}");
            }
            return;
        }
    }
}

/// Open the default input device and build an input stream whose callback streams
/// every sample (converted to f32) to the spill file on disk.
#[allow(clippy::type_complexity)]
fn build_stream(
    spill_path: &Path,
) -> Result<(cpal::Stream, SpillWriter, Arc<AtomicBool>, u32, u16), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no microphone / input device is available".to_string())?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("cannot read the microphone's default config: {e}"))?;

    let sample_rate = supported.sample_rate();
    let channels = supported.channels();
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    let file = File::create(spill_path)
        .map_err(|e| format!("cannot create the recording buffer file: {e}"))?;
    let writer: SpillWriter = Arc::new(Mutex::new(BufWriter::new(file)));
    let write_failed = Arc::new(AtomicBool::new(false));
    let err_fn = |e| log::error!("voice capture stream error: {e}");

    // A dropped/denied stream surfaces here (permission denied or device busy).
    let map_build =
        |e| format!("cannot open the microphone (permission denied or device busy): {e}");

    let stream = match sample_format {
        SampleFormat::F32 => {
            let w = writer.clone();
            let failed = write_failed.clone();
            device.build_input_stream(
                config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    spill_samples(&w, &failed, data);
                },
                err_fn,
                None,
            )
        }
        SampleFormat::I16 => {
            let w = writer.clone();
            let failed = write_failed.clone();
            device.build_input_stream(
                config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    let f: Vec<f32> = data.iter().map(|&s| f32::from_sample(s)).collect();
                    spill_samples(&w, &failed, &f);
                },
                err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let w = writer.clone();
            let failed = write_failed.clone();
            device.build_input_stream(
                config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    let f: Vec<f32> = data.iter().map(|&s| f32::from_sample(s)).collect();
                    spill_samples(&w, &failed, &f);
                },
                err_fn,
                None,
            )
        }
        other => {
            return Err(format!(
                "unsupported microphone sample format: {other:?} (expected f32, i16, or u16)"
            ))
        }
    }
    .map_err(map_build)?;

    Ok((stream, writer, write_failed, sample_rate, channels))
}

/// Stream a raw interleaved-f32 spill file through the downmix + linear-resample
/// DSP straight into a 16 kHz mono 16-bit PCM WAV, returning the number of output
/// samples written. Peak memory is bounded (a two-sample interpolation window +
/// I/O buffers), independent of recording length.
///
/// This is proven bit-identical to the eager [`to_16k_mono`] + [`write_wav_16k_mono`]
/// path (see `streaming_finalize_matches_reference*` tests): it downmixes each
/// frame in channel order and applies the exact same linear-interpolation formula
/// over the same `out_len = round(frames * ratio)`.
fn stream_spill_to_wav_16k_mono(
    spill: &Path,
    channels: u16,
    sample_rate: u32,
    out_path: &Path,
) -> Result<usize, String> {
    let ch = channels.max(1) as usize;
    let file = File::open(spill).map_err(|e| e.to_string())?;
    let total_samples = (file.metadata().map_err(|e| e.to_string())?.len() / 4) as usize;
    let frames = total_samples / ch;

    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(out_path, spec).map_err(|e| e.to_string())?;
    let mut mono = MonoReader::new(BufReader::new(file), ch, frames);
    let mut count = 0usize;

    let write_sample = |writer: &mut hound::WavWriter<_>, s: f32| -> Result<(), String> {
        let clamped = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer.write_sample(clamped).map_err(|e| e.to_string())
    };

    // Mirror `resample_linear`'s no-op branch: same rate (or a degenerate rate /
    // no frames) is a straight mono copy.
    if sample_rate == TARGET_RATE || sample_rate == 0 || frames == 0 {
        while let Some(s) = mono.next_mono().map_err(|e| e.to_string())? {
            write_sample(&mut writer, s)?;
            count += 1;
        }
    } else {
        let ratio = TARGET_RATE as f64 / sample_rate as f64;
        let out_len = ((frames as f64) * ratio).round() as usize;
        if out_len > 0 {
            // A sliding two-sample window: `a` == mono[idx_loaded], `b` == the next
            // sample (or `a` past the end, matching `get(idx+1).unwrap_or(a)`).
            let mut idx_loaded = 0usize;
            let mut a = mono
                .next_mono()
                .map_err(|e| e.to_string())?
                .expect("frames > 0 guarantees at least one mono sample");
            let mut b = mono.next_mono().map_err(|e| e.to_string())?.unwrap_or(a);
            for i in 0..out_len {
                let src = i as f64 / ratio;
                let idx = src.floor() as usize;
                let frac = (src - idx as f64) as f32;
                while idx_loaded < idx {
                    a = b;
                    b = mono.next_mono().map_err(|e| e.to_string())?.unwrap_or(a);
                    idx_loaded += 1;
                }
                write_sample(&mut writer, a + (b - a) * frac)?;
                count += 1;
            }
        }
    }

    writer.finalize().map_err(|e| e.to_string())?;
    Ok(count)
}

/// Reads a raw interleaved-f32 stream one mono frame at a time, downmixing each
/// frame (average over `channels`, in channel order) exactly like
/// [`downmix_to_mono`]. Yields at most `frames` samples, dropping any partial
/// trailing frame (matching `interleaved.len() / ch`).
struct MonoReader<R: Read> {
    reader: R,
    channels: usize,
    frames_left: usize,
    buf: [u8; 4],
}

impl<R: Read> MonoReader<R> {
    fn new(reader: R, channels: usize, frames: usize) -> Self {
        Self {
            reader,
            channels,
            frames_left: frames,
            buf: [0u8; 4],
        }
    }

    /// The next downmixed mono sample, or `None` once `frames` are exhausted.
    fn next_mono(&mut self) -> std::io::Result<Option<f32>> {
        if self.frames_left == 0 {
            return Ok(None);
        }
        let mut sum = 0.0f32;
        for _ in 0..self.channels {
            self.reader.read_exact(&mut self.buf)?;
            sum += f32::from_le_bytes(self.buf);
        }
        self.frames_left -= 1;
        Ok(Some(sum / self.channels as f32))
    }
}

// ── Pure DSP + WAV helpers (unit-tested) ────────────────────────────────────

/// Average interleaved multi-channel samples into one mono channel. A mono input
/// passes through unchanged; a channel count of 0 is treated as mono.
pub fn downmix_to_mono(interleaved: &[f32], channels: u16) -> Vec<f32> {
    let ch = channels.max(1) as usize;
    if ch == 1 {
        return interleaved.to_vec();
    }
    let frames = interleaved.len() / ch;
    let mut out = Vec::with_capacity(frames);
    for f in 0..frames {
        let mut sum = 0.0f32;
        for c in 0..ch {
            sum += interleaved[f * ch + c];
        }
        out.push(sum / ch as f32);
    }
    out
}

/// Resample a mono signal from `from_rate` to `to_rate` by linear interpolation.
/// Good enough for speech (a building foundation) — not a polyphase/anti-aliased
/// resampler; see the module note. A no-op when the rates match.
pub fn resample_linear(mono: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || mono.is_empty() || from_rate == 0 {
        return mono.to_vec();
    }
    let ratio = to_rate as f64 / from_rate as f64;
    let out_len = ((mono.len() as f64) * ratio).round() as usize;
    if out_len == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let frac = (src - idx as f64) as f32;
        let a = mono.get(idx).copied().unwrap_or(0.0);
        let b = mono.get(idx + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

/// Downmix + resample interleaved device audio to 16 kHz mono for whisper.
pub fn to_16k_mono(interleaved: &[f32], channels: u16, sample_rate: u32) -> Vec<f32> {
    let mono = downmix_to_mono(interleaved, channels);
    resample_linear(&mono, sample_rate, TARGET_RATE)
}

/// Write mono 16 kHz f32 samples as a 16-bit PCM WAV. The production finalize now
/// streams the same encoding inline ([`stream_spill_to_wav_16k_mono`]); this eager
/// helper is kept only as the reference that proves the streamed path identical.
#[cfg(test)]
pub fn write_wav_16k_mono(path: &Path, samples: &[f32]) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).map_err(|e| e.to_string())?;
    for &s in samples {
        let clamped = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer.write_sample(clamped).map_err(|e| e.to_string())?;
    }
    writer.finalize().map_err(|e| e.to_string())?;
    Ok(())
}

/// Read a WAV back as 16 kHz mono f32 (downmixing/resampling as needed), so any
/// WAV — not just ones we wrote — can be transcribed.
pub fn read_wav_as_16k_mono(path: &Path) -> Result<Vec<f32>, String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| e.to_string())?;
    let spec = reader.spec();
    let raw: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?,
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|r| r.map(|s| s as f32 / scale))
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?
        }
    };
    Ok(to_16k_mono(&raw, spec.channels, spec.sample_rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_without_recording_fails_loud() {
        // No test in this suite ever starts a capture (no mic in CI), so the
        // global RECORDER is reliably empty here.
        let e = cancel().unwrap_err();
        assert_eq!(e.kind, "voiceNotRecording");
    }

    #[test]
    fn downmix_averages_stereo_to_mono() {
        // Two stereo frames: (0.0, 1.0) and (0.5, -0.5).
        let out = downmix_to_mono(&[0.0, 1.0, 0.5, -0.5], 2);
        assert_eq!(out, vec![0.5, 0.0]);
    }

    #[test]
    fn downmix_passes_mono_through() {
        assert_eq!(downmix_to_mono(&[0.1, 0.2, 0.3], 1), vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn resample_is_a_noop_at_the_same_rate() {
        let s = vec![0.0, 0.5, 1.0];
        assert_eq!(resample_linear(&s, 16_000, 16_000), s);
    }

    #[test]
    fn resample_upsamples_with_linear_interpolation() {
        // Doubling the rate inserts an interpolated sample between originals.
        let out = resample_linear(&[0.0, 1.0], 1, 2);
        assert_eq!(out.len(), 4);
        assert!((out[0] - 0.0).abs() < 1e-6);
        assert!((out[1] - 0.5).abs() < 1e-6);
        assert!((out[2] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn resample_downsamples_toward_the_target_length() {
        let src: Vec<f32> = (0..48).map(|i| (i as f32) / 48.0).collect();
        let out = resample_linear(&src, 48_000, 16_000);
        assert_eq!(out.len(), 16);
    }

    /// Write raw interleaved f32 to a scratch spill file the way the capture
    /// thread does, so the streaming finalize can be exercised without a mic.
    fn write_spill(dir: &Path, name: &str, interleaved: &[f32]) -> PathBuf {
        let path = dir.join(name);
        let mut w = BufWriter::new(File::create(&path).unwrap());
        for &s in interleaved {
            w.write_all(&s.to_le_bytes()).unwrap();
        }
        w.flush().unwrap();
        path
    }

    /// The i16 PCM samples of a mono 16 kHz WAV, for comparing encoder output.
    fn read_wav_i16(path: &Path) -> Vec<i16> {
        let mut r = hound::WavReader::open(path).unwrap();
        assert_eq!(r.spec().channels, 1);
        assert_eq!(r.spec().sample_rate, TARGET_RATE);
        assert_eq!(r.spec().bits_per_sample, 16);
        r.samples::<i16>().map(|s| s.unwrap()).collect()
    }

    /// The streaming finalize must be BIT-IDENTICAL to the old eager path
    /// (`to_16k_mono` + `write_wav_16k_mono`) — a behavior-preserving perf change.
    fn assert_stream_matches_reference(interleaved: &[f32], channels: u16, sample_rate: u32) {
        let dir = std::env::temp_dir().join(format!(
            "nv-voice-stream-{}-{:p}",
            std::process::id(),
            interleaved
        ));
        std::fs::create_dir_all(&dir).unwrap();

        // Reference: the eager path this change replaces.
        let mono16k = to_16k_mono(interleaved, channels, sample_rate);
        let ref_path = dir.join("ref.wav");
        write_wav_16k_mono(&ref_path, &mono16k).unwrap();
        let reference = read_wav_i16(&ref_path);

        // Streamed: spill file → streaming resample/encode.
        let spill = write_spill(&dir, "spill.f32", interleaved);
        let streamed_path = dir.join("streamed.wav");
        let count =
            stream_spill_to_wav_16k_mono(&spill, channels, sample_rate, &streamed_path).unwrap();
        let streamed = read_wav_i16(&streamed_path);

        assert_eq!(
            count,
            mono16k.len(),
            "output sample count diverged (ch={channels}, rate={sample_rate})"
        );
        assert_eq!(
            streamed, reference,
            "streamed WAV diverged from the eager reference (ch={channels}, rate={sample_rate})"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn streaming_finalize_matches_reference_stereo_48k() {
        // A realistic take: stereo 48 kHz downsampled to 16 kHz mono.
        let frames = 48_000; // ~1s
        let mut interleaved = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            let t = i as f32 / 48_000.0;
            interleaved.push((t * 220.0 * std::f32::consts::TAU).sin() * 0.7); // L
            interleaved.push((t * 330.0 * std::f32::consts::TAU).sin() * 0.4); // R
        }
        assert_stream_matches_reference(&interleaved, 2, 48_000);
    }

    #[test]
    fn streaming_finalize_matches_reference_mono_already_16k() {
        // The resample no-op branch: mono already at the target rate.
        let samples: Vec<f32> = (0..1600).map(|i| ((i as f32) * 0.02).sin() * 0.5).collect();
        assert_stream_matches_reference(&samples, 1, 16_000);
    }

    #[test]
    fn streaming_finalize_matches_reference_mono_44100_upsample() {
        // Upsampling path (44.1 kHz → 16 kHz is a downsample; use 8 kHz → 16 kHz
        // to exercise ratio > 1 as well).
        let up: Vec<f32> = (0..800).map(|i| ((i as f32) * 0.05).cos() * 0.6).collect();
        assert_stream_matches_reference(&up, 1, 8_000);
        let down: Vec<f32> = (0..4410).map(|i| ((i as f32) * 0.03).sin() * 0.6).collect();
        assert_stream_matches_reference(&down, 1, 44_100);
    }

    #[test]
    fn streaming_finalize_produces_complete_16k_mono_wav() {
        // "Streamed file valid + complete": exact duration/length for a known input.
        let dir = std::env::temp_dir().join(format!("nv-voice-complete-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // 2s of mono already at 16 kHz → exactly 32_000 output samples, no resample.
        let samples: Vec<f32> = (0..32_000)
            .map(|i| ((i as f32) * 0.01).sin() * 0.3)
            .collect();
        let spill = write_spill(&dir, "complete.f32", &samples);
        let out = dir.join("out.wav");
        let count = stream_spill_to_wav_16k_mono(&spill, 1, 16_000, &out).unwrap();
        assert_eq!(count, 32_000);
        let back = read_wav_i16(&out);
        assert_eq!(back.len(), 32_000, "WAV is truncated / not fully flushed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finalize_empty_spill_fails_loud() {
        // A zero-length spill (no audio captured) surfaces `voiceEmpty`, matching
        // the old `captured.samples.is_empty()` guard.
        let dir = std::env::temp_dir().join(format!("nv-voice-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let spill = write_spill(&dir, "empty.f32", &[]);
        let meta = CaptureMeta {
            sample_rate: 48_000,
            channels: 2,
        };
        let out = dir.join("out.wav");
        let e = match finalize(&spill, &meta, &out) {
            Err(e) => e,
            Ok(_) => panic!("expected an empty-spill error"),
        };
        assert_eq!(e.kind, "voiceEmpty");
        assert!(!out.exists(), "no WAV should be written for an empty take");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wav_round_trips_within_quantization_error() {
        let dir = std::env::temp_dir().join(format!("nv-voice-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rt.wav");
        let samples: Vec<f32> = (0..1600).map(|i| ((i as f32) * 0.01).sin() * 0.5).collect();
        write_wav_16k_mono(&path, &samples).unwrap();

        let back = read_wav_as_16k_mono(&path).unwrap();
        assert_eq!(back.len(), samples.len());
        // 16-bit quantization tolerance.
        for (a, b) in samples.iter().zip(back.iter()) {
            assert!((a - b).abs() < 1e-3, "sample drift too large: {a} vs {b}");
        }
        let _ = std::fs::remove_file(&path);
    }
}
