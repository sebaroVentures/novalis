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

/// Pinned identity of the bytes [`MODEL_URL`] serves. Source: the model's git-LFS
/// pointer in the `ggerganov/whisper.cpp` HuggingFace repo
/// (`…/whisper.cpp/raw/main/ggml-base.en.bin` → `oid sha256:…` / `size …`,
/// fetched 2026-07-17 and verified against a locally downloaded copy); it is the
/// same file whisper.cpp's `models/download-ggml-model.sh` fetches. A freshly
/// downloaded model must match BOTH constants before it replaces the cache; a
/// cached model is re-checked by size only (hashing ~142 MB per load is too
/// slow — the context is loaded on every transcription).
const MODEL_SHA256: &str = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";
const MODEL_SIZE: u64 = 147_964_211;

fn err(kind: &str, msg: impl Into<String>) -> CommandError {
    CommandError {
        kind: kind.to_string(),
        message: msg.into(),
    }
}

/// Ensure the model exists under `cache_dir`, downloading it on first use.
/// Blocking (a ~142 MB download on the first call). Downloads to a `.part` file,
/// verifies it against [`MODEL_SHA256`]/[`MODEL_SIZE`], and renames on success —
/// an interrupted or tampered download never becomes the cached model. A cached
/// model with the wrong size (e.g. cleanly truncated) is redownloaded.
pub fn ensure_model(cache_dir: &Path) -> Result<PathBuf, CommandError> {
    std::fs::create_dir_all(cache_dir).map_err(|e| {
        err(
            "voiceModel",
            format!("cannot create the model cache dir: {e}"),
        )
    })?;
    let dest = cache_dir.join(MODEL_FILE);
    match std::fs::metadata(&dest).map(|m| m.len()) {
        Ok(len) if len == MODEL_SIZE => return Ok(dest),
        Ok(len) => {
            log::warn!(
                "cached transcription model has the wrong size ({len} B, expected {MODEL_SIZE} B) — redownloading"
            );
            std::fs::remove_file(&dest).map_err(|e| {
                err(
                    "voiceModel",
                    format!("cannot remove the corrupt cached model: {e}"),
                )
            })?;
        }
        Err(_) => {}
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
    verify_download(&tmp, MODEL_SIZE, MODEL_SHA256)?;
    std::fs::rename(&tmp, &dest)
        .map_err(|e| err("voiceModel", format!("cannot finalize the model file: {e}")))?;
    Ok(dest)
}

/// Verify a downloaded `.part` file against the pinned size + SHA-256 before it
/// may become the cached model. Fails loud on any mismatch AND deletes the file,
/// so a truncated/tampered download is never retried into the cache.
fn verify_download(
    tmp: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), CommandError> {
    let fail = |msg: String| {
        let _ = std::fs::remove_file(tmp);
        err("voiceModel", msg)
    };
    let len = std::fs::metadata(tmp)
        .map(|m| m.len())
        .map_err(|e| fail(format!("cannot stat the downloaded model: {e}")))?;
    if len != expected_size {
        return Err(fail(format!(
            "downloaded model has the wrong size ({len} B, expected {expected_size} B) — the download was truncated or the published model changed"
        )));
    }
    let actual =
        sha256_hex(tmp).map_err(|e| fail(format!("cannot hash the downloaded model: {e}")))?;
    if actual != expected_sha256 {
        return Err(fail(format!(
            "downloaded model failed its SHA-256 check (got {actual}, expected {expected_sha256}) — refusing to use it"
        )));
    }
    Ok(())
}

/// Lowercase hex SHA-256 of a file, streamed (never loads ~142 MB into memory).
fn sha256_hex(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// SHA-256 of the ASCII bytes `abc` (FIPS 180-2 test vector).
    const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[test]
    fn sha256_hex_matches_a_known_vector() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("abc.bin");
        std::fs::write(&path, b"abc").unwrap();
        assert_eq!(sha256_hex(&path).unwrap(), ABC_SHA256);
    }

    #[test]
    fn verify_download_accepts_matching_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.part");
        std::fs::write(&path, b"abc").unwrap();
        verify_download(&path, 3, ABC_SHA256).unwrap();
        assert!(path.exists(), "a verified download must be kept");
    }

    #[test]
    fn verify_download_rejects_a_truncated_file_and_deletes_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.part");
        std::fs::write(&path, b"ab").unwrap();
        let e = verify_download(&path, 3, ABC_SHA256).unwrap_err();
        assert_eq!(e.kind, "voiceModel");
        assert!(e.message.contains("wrong size"), "{}", e.message);
        assert!(!path.exists(), "a failed download must be deleted");
    }

    #[test]
    fn verify_download_rejects_a_hash_mismatch_and_deletes_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.part");
        std::fs::write(&path, b"abd").unwrap();
        let e = verify_download(&path, 3, ABC_SHA256).unwrap_err();
        assert_eq!(e.kind, "voiceModel");
        assert!(e.message.contains("SHA-256"), "{}", e.message);
        assert!(!path.exists(), "a failed download must be deleted");
    }
}
