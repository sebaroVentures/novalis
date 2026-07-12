//! On-device transcription (desktop only) via `whisper-rs` (whisper.cpp).
//!
//! Privacy-first: audio is transcribed entirely on the machine — nothing is ever
//! uploaded. Mirrors the on-device embedder's model management
//! (`crate::ai::embed_local`): the inference engine (whisper.cpp) is compiled
//! into the binary at build time, and the *model weights* download from
//! HuggingFace on first use and cache under the app-data dir; every later run is
//! fully offline.
//!
//! ## Model
//! `ggml-base.en.bin` — the English-only `base` whisper model, ~142 MB. A small,
//! CPU-friendly default that transcribes short meeting clips in reasonable time;
//! the single [`MODEL_FILE`]/[`MODEL_URL`] pair makes it swappable.
//!
//! ## Threading
//! whisper inference is CPU-bound and blocking; callers MUST run [`transcribe`]
//! (and [`ensure_model`], which may download ~142 MB) on a blocking thread, never
//! on the async runtime. The context is loaded per call: a recording is a
//! one-shot, so there is nothing to amortize across (unlike the batched embedder).

use std::path::{Path, PathBuf};
use std::time::Duration;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::engine::CommandError;

/// The bundled-by-download model file name (also its cache key on disk).
pub const MODEL_FILE: &str = "ggml-base.en.bin";

/// Where the weights are fetched on first use. HuggingFace serves the official
/// whisper.cpp ggml models over HTTPS (rustls — the app stays openssl-free).
const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

fn err(kind: &str, msg: impl Into<String>) -> CommandError {
    CommandError {
        kind: kind.to_string(),
        message: msg.into(),
    }
}

/// Ensure the model exists under `cache_dir`, downloading it on first use.
/// Blocking (a ~142 MB download on the first call). Downloads to a `.part` file
/// and renames on success, so an interrupted download never leaves a truncated
/// model that looks present.
pub fn ensure_model(cache_dir: &Path) -> Result<PathBuf, CommandError> {
    std::fs::create_dir_all(cache_dir).map_err(|e| {
        err(
            "voiceModel",
            format!("cannot create the model cache dir: {e}"),
        )
    })?;
    let dest = cache_dir.join(MODEL_FILE);
    if std::fs::metadata(&dest)
        .map(|m| m.len() > 0)
        .unwrap_or(false)
    {
        return Ok(dest);
    }

    let tmp = cache_dir.join(format!("{MODEL_FILE}.part"));
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| {
            err(
                "voiceModel",
                format!("cannot build the download client: {e}"),
            )
        })?;
    let mut resp = client.get(MODEL_URL).send().map_err(|e| {
        err(
            "voiceModel",
            format!("failed to download the transcription model: {e}"),
        )
    })?;
    if !resp.status().is_success() {
        return Err(err(
            "voiceModel",
            format!("model download failed (HTTP {})", resp.status().as_u16()),
        ));
    }
    let mut file = std::fs::File::create(&tmp)
        .map_err(|e| err("voiceModel", format!("cannot create the model file: {e}")))?;
    std::io::copy(&mut resp, &mut file)
        .map_err(|e| err("voiceModel", format!("failed while saving the model: {e}")))?;
    file.sync_all().ok();
    drop(file);
    std::fs::rename(&tmp, &dest)
        .map_err(|e| err("voiceModel", format!("cannot finalize the model file: {e}")))?;
    Ok(dest)
}

/// Transcribe 16 kHz mono f32 audio into text. Blocking — run on a blocking
/// thread. Fails loud on an empty clip or any whisper error.
pub fn transcribe(model_path: &Path, samples_16k_mono: &[f32]) -> Result<String, CommandError> {
    if samples_16k_mono.is_empty() {
        return Err(err("voiceTranscribe", "there is no audio to transcribe"));
    }

    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| {
            err(
                "voiceTranscribe",
                format!("failed to load the transcription model: {e}"),
            )
        })?;
    let mut state = ctx.create_state().map_err(|e| {
        err(
            "voiceTranscribe",
            format!("failed to init transcription state: {e}"),
        )
    })?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    // The base.en model is English-only; suppress whisper's own stdout prints.
    params.set_language(Some("en"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    let threads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(8) as i32;
    params.set_n_threads(threads);

    state
        .full(params, samples_16k_mono)
        .map_err(|e| err("voiceTranscribe", format!("transcription failed: {e}")))?;

    // Concatenate every decoded segment's text into one transcript.
    let mut out = String::new();
    for segment in state.as_iter() {
        let text = segment.to_str_lossy().map_err(|e| {
            err(
                "voiceTranscribe",
                format!("cannot read a transcript segment: {e}"),
            )
        })?;
        let text = text.trim();
        if !text.is_empty() {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(text);
        }
    }
    Ok(out)
}
