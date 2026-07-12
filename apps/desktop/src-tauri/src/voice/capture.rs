//! Microphone capture (desktop only) via `cpal`.
//!
//! `cpal`'s `Stream` is `!Send`, so it can never live in Tauri-managed state or
//! cross an await point. Instead a dedicated OS thread owns the stream for its
//! whole life: it builds + plays the input stream, the audio callback appends
//! captured samples to a shared buffer, and the thread parks on a stop channel.
//! The module-level [`RECORDER`] holds only the `Send` control handle (a stop
//! sender + the thread's `JoinHandle`), so no `!Send` value ever escapes.
//!
//! On stop we downmix to mono and resample to 16 kHz — the rate whisper expects
//! — then write a 16-bit PCM WAV artifact under the app-data dir. The pure DSP
//! helpers ([`downmix_to_mono`], [`resample_linear`]) and the WAV round-trip are
//! unit-tested; real device capture is exercised out-of-band (no mic in CI).
//!
//! ## macOS permission reality
//! Building the input stream fails loudly here when no input device exists or the
//! OS denies mic access, so [`start`] surfaces a clear error rather than silently
//! recording nothing. The bundle's `NSMicrophoneUsageDescription` (see
//! `src-tauri/Info.plist`) is what lets macOS show the permission prompt at all;
//! without it the first capture attempt is denied by TCC.

use std::path::{Path, PathBuf};
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
    /// Yields the captured, un-resampled interleaved samples + device config.
    join: JoinHandle<Result<Captured, String>>,
}

/// Raw capture handed back by the thread: interleaved f32 samples at the
/// device's native rate and channel count.
struct Captured {
    samples: Vec<f32>,
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

    let join = std::thread::Builder::new()
        .name("voice-capture".into())
        .spawn(move || capture_thread(ready_tx, stop_rx))
        .map_err(|e| {
            err(
                "voiceCapture",
                format!("cannot start the capture thread: {e}"),
            )
        })?;

    match ready_rx.recv() {
        Ok(Ok(())) => {
            *guard = Some(Recorder { stop_tx, join });
            Ok(())
        }
        // The thread failed to open the mic; join it to reclaim the error.
        Ok(Err(msg)) => {
            let _ = join.join();
            Err(err("voiceCapture", msg))
        }
        Err(_) => {
            let _ = join.join();
            Err(err(
                "voiceCapture",
                "the capture thread exited before starting",
            ))
        }
    }
}

/// Stop the in-progress recording, normalize it to 16 kHz mono, and write a
/// 16-bit PCM WAV to `out_path`. Fails loud when nothing is recording or no
/// audio was captured (muted mic / denied permission).
pub fn stop(out_path: &Path) -> Result<Recording, CommandError> {
    let recorder = {
        let mut guard = RECORDER.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .take()
            .ok_or_else(|| err("voiceNotRecording", "no recording is in progress"))?
    };

    // Tell the thread to stop (a dropped sender would also do it) and collect.
    let _ = recorder.stop_tx.send(());
    let captured = recorder
        .join
        .join()
        .map_err(|_| err("voiceCapture", "the capture thread panicked"))?
        .map_err(|msg| err("voiceCapture", msg))?;

    if captured.samples.is_empty() {
        return Err(err(
            "voiceEmpty",
            "no audio was captured — is the microphone muted or was permission denied?",
        ));
    }

    let mono16k = to_16k_mono(&captured.samples, captured.channels, captured.sample_rate);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            err(
                "voiceCapture",
                format!("cannot create the recording dir: {e}"),
            )
        })?;
    }
    write_wav_16k_mono(out_path, &mono16k)
        .map_err(|e| err("voiceCapture", format!("cannot write the recording: {e}")))?;

    Ok(Recording {
        path: out_path.to_path_buf(),
        duration_secs: mono16k.len() as f64 / TARGET_RATE as f64,
    })
}

/// Owns the `!Send` stream for its whole life. Builds + plays the input stream,
/// signals readiness, parks until stopped, then returns the raw capture.
fn capture_thread(
    ready_tx: mpsc::Sender<Result<(), String>>,
    stop_rx: mpsc::Receiver<()>,
) -> Result<Captured, String> {
    // Build everything inside a closure so any failure is one `?`-chain we can
    // report through `ready_tx`. The `Stream` never leaves this thread.
    let built = build_stream();
    match built {
        Err(e) => {
            let _ = ready_tx.send(Err(e.clone()));
            Err(e)
        }
        Ok((stream, buffer, sample_rate, channels)) => {
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
            drop(stream);
            let samples = std::mem::take(&mut *buffer.lock().unwrap_or_else(|e| e.into_inner()));
            Ok(Captured {
                samples,
                sample_rate,
                channels,
            })
        }
    }
}

/// Open the default input device and build an input stream whose callback
/// appends every sample (converted to f32) to a shared buffer.
#[allow(clippy::type_complexity)]
fn build_stream() -> Result<(cpal::Stream, Arc<Mutex<Vec<f32>>>, u32, u16), String> {
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

    let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
    let err_fn = |e| log::error!("voice capture stream error: {e}");

    // A dropped/denied stream surfaces here (permission denied or device busy).
    let map_build =
        |e| format!("cannot open the microphone (permission denied or device busy): {e}");

    let stream = match sample_format {
        SampleFormat::F32 => {
            let buf = buffer.clone();
            device.build_input_stream(
                config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if let Ok(mut b) = buf.lock() {
                        b.extend_from_slice(data);
                    }
                },
                err_fn,
                None,
            )
        }
        SampleFormat::I16 => {
            let buf = buffer.clone();
            device.build_input_stream(
                config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if let Ok(mut b) = buf.lock() {
                        b.extend(data.iter().map(|&s| f32::from_sample(s)));
                    }
                },
                err_fn,
                None,
            )
        }
        SampleFormat::U16 => {
            let buf = buffer.clone();
            device.build_input_stream(
                config,
                move |data: &[u16], _: &cpal::InputCallbackInfo| {
                    if let Ok(mut b) = buf.lock() {
                        b.extend(data.iter().map(|&s| f32::from_sample(s)));
                    }
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

    Ok((stream, buffer, sample_rate, channels))
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

/// Write mono 16 kHz f32 samples as a 16-bit PCM WAV.
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
