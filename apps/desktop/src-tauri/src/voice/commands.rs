//! Tauri commands for native voice/meeting capture (feature W4.3).
//!
//! Record the mic, transcribe it on-device, and hand the transcript back to the
//! frontend, which writes a transcript note and runs the existing hidden
//! `extract-tasks` action through its accept/reject review — so there is no new
//! AI action and no schema change here.
//!
//! The heavy native impl ([`crate::voice::capture`] / [`crate::voice::transcribe`])
//! is desktop-only, gated off Android like the on-device embedder. These command
//! wrappers are always compiled so the command/binding surface is identical
//! across targets; on Android they return a clear "not available" error.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

#[cfg(not(target_os = "android"))]
use std::path::PathBuf;
#[cfg(not(target_os = "android"))]
use tauri::Manager;

use crate::engine::CommandError;

type CmdResult<T> = Result<T, CommandError>;

/// A finalized recording: a 16 kHz mono WAV under the app-data dir, plus its
/// duration. Ready to hand to [`voice_transcribe`].
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceRecording {
    pub path: String,
    pub duration_secs: f64,
}

/// Whether native capture + transcription is available on this platform, and the
/// model it uses (so the capture UI can hint at the first-use model download).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCapabilities {
    pub available: bool,
    pub model: String,
}

/// Report whether voice capture works here (false on mobile).
#[tauri::command]
#[specta::specta]
pub fn voice_capabilities() -> VoiceCapabilities {
    #[cfg(not(target_os = "android"))]
    {
        VoiceCapabilities {
            available: true,
            model: crate::voice::transcribe::MODEL_FILE.to_string(),
        }
    }
    #[cfg(target_os = "android")]
    {
        VoiceCapabilities {
            available: false,
            model: String::new(),
        }
    }
}

/// Start capturing the default microphone. Fails loudly when no input device is
/// available or the OS denies mic access.
#[tauri::command]
#[specta::specta]
pub fn voice_start_recording() -> CmdResult<()> {
    start_impl()
}

/// Stop capturing and finalize the recording as a WAV under `app-data/voice/`.
/// Finalize (join + resample + WAV-encode) runs on a blocking thread so the main
/// thread never freezes on Stop, even for long recordings.
#[tauri::command]
#[specta::specta]
pub async fn voice_stop_recording(app: AppHandle) -> CmdResult<VoiceRecording> {
    stop_impl(&app).await
}

/// Cancel the in-progress recording, discarding the audio without writing a WAV.
#[tauri::command]
#[specta::specta]
pub fn voice_cancel_recording() -> CmdResult<()> {
    cancel_impl()
}

/// Delete a finalized recording from `app-data/voice/`. Accepts ONLY a bare
/// `recording-<uuid>.wav` file name (the exact artifact names `stop_impl`
/// produces) so it can never reach outside the voice dir.
#[tauri::command]
#[specta::specta]
pub fn voice_delete_recording(app: AppHandle, file_name: String) -> CmdResult<()> {
    delete_impl(&app, &file_name)
}

/// Transcribe a recorded WAV on-device. Downloads + caches the whisper model on
/// first use; runs off the async runtime (whisper is CPU-bound and blocking).
/// Gated on the voice feature flag HERE (not just in the UI) because the first
/// call silently re-downloads the ~142 MB model — a deleted cache must stay
/// deleted while the feature is off. An unreadable config never
/// default-enables.
#[tauri::command]
#[specta::specta]
pub async fn voice_transcribe(app: AppHandle, wav_path: String) -> CmdResult<String> {
    // Desktop-only gate: the Android impl below errors "unavailable" anyway.
    #[cfg(not(target_os = "android"))]
    {
        let vault = app
            .state::<crate::engine::AppEngine>()
            .with(|e| Ok(e.vault_path.clone()))?;
        let voice_on = novalis_core::vault::config::try_read_preferences(&vault)
            .map(|p| p.features.voice)
            .unwrap_or(false);
        if !voice_on {
            return Err(CommandError {
                kind: "badRequest".to_string(),
                message: "voice notes are disabled in Settings › Features".to_string(),
            });
        }
    }
    transcribe_impl(app, wav_path).await
}

/// Bytes the cached whisper model occupies on disk (0 = not downloaded).
#[tauri::command]
#[specta::specta]
pub fn voice_model_status(app: AppHandle) -> CmdResult<u64> {
    model_status_impl(&app)
}

/// Settings › Features "delete & free space" for voice notes: remove the
/// app-global cached whisper weights (and any half-finished `.part` download).
/// Recordings are untouched. Returns the bytes freed. Deliberately NOT gated
/// on the feature flag — deleting leftovers is what a switched-off feature
/// needs.
#[tauri::command]
#[specta::specta]
pub fn voice_delete_model(app: AppHandle) -> CmdResult<u64> {
    delete_model_impl(&app)
}

// ── Desktop implementation ──────────────────────────────────────────────────

#[cfg(not(target_os = "android"))]
fn start_impl() -> CmdResult<()> {
    crate::voice::capture::start()
}

#[cfg(not(target_os = "android"))]
async fn stop_impl(app: &AppHandle) -> CmdResult<VoiceRecording> {
    let dir = voice_dir(app)?;
    let path = dir.join(format!("recording-{}.wav", uuid::Uuid::new_v4()));
    // `capture::stop` is blocking (join + streaming resample + WAV-encode); run it
    // off the async runtime so the UI thread never freezes on Stop.
    let rec = tauri::async_runtime::spawn_blocking(move || crate::voice::capture::stop(&path))
        .await
        .map_err(|e| CommandError::internal(format!("finalize task failed: {e}")))??;
    Ok(VoiceRecording {
        path: rec.path.to_string_lossy().to_string(),
        duration_secs: rec.duration_secs,
    })
}

#[cfg(not(target_os = "android"))]
fn cancel_impl() -> CmdResult<()> {
    crate::voice::capture::cancel()
}

#[cfg(not(target_os = "android"))]
fn delete_impl(app: &AppHandle, file_name: &str) -> CmdResult<()> {
    if !is_recording_file_name(file_name) {
        return Err(CommandError {
            kind: "voiceDelete".to_string(),
            message: format!("not a recording file name: {file_name}"),
        });
    }
    let path = voice_dir(app)?.join(file_name);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // Already gone (e.g. the startup sweep beat us) — deletion is idempotent.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(CommandError::internal(format!(
            "cannot delete the recording: {e}"
        ))),
    }
}

/// Whether `name` is exactly a `recording-<uuid>.wav` file name as produced by
/// `stop_impl`. The strict shape (prefix + parseable UUID + suffix) rejects any
/// path separator, `..`, or absolute path, so [`voice_delete_recording`] and the
/// startup sweep can only ever touch our own artifacts inside the voice dir.
#[cfg(not(target_os = "android"))]
fn is_recording_file_name(name: &str) -> bool {
    name.strip_prefix("recording-")
        .and_then(|rest| rest.strip_suffix(".wav"))
        .is_some_and(|id| uuid::Uuid::try_parse(id).is_ok())
}

/// Remove stale `recording-<uuid>.wav` takes left in `app-data/voice/` (crashed
/// runs, pre-cleanup versions). Called once from app setup, BEFORE the webview
/// can invoke any command, so it cannot race an active take — and it re-checks
/// the recorder state anyway. Best-effort: failures are logged, never fatal.
#[cfg(not(target_os = "android"))]
pub fn sweep_stale_recordings(app: &AppHandle) {
    if crate::voice::capture::is_recording() {
        return;
    }
    let dir = match voice_dir(app) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("voice sweep: cannot resolve the voice dir: {}", e.message);
            return;
        }
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("voice sweep: cannot read the voice dir: {e}");
            return;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if is_recording_file_name(name) {
            if let Err(e) = std::fs::remove_file(entry.path()) {
                log::warn!("voice sweep: cannot delete stale recording {name}: {e}");
            }
        }
    }
}

#[cfg(not(target_os = "android"))]
async fn transcribe_impl(app: AppHandle, wav_path: String) -> CmdResult<String> {
    let cache_dir = model_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let model = crate::voice::transcribe::ensure_model(&cache_dir)?;
        let samples = crate::voice::capture::read_wav_as_16k_mono(std::path::Path::new(&wav_path))
            .map_err(|e| CommandError {
                kind: "voiceTranscribe".to_string(),
                message: format!("cannot read the recording: {e}"),
            })?;
        crate::voice::transcribe::transcribe(&model, &samples)
    })
    .await
    .map_err(|e| CommandError::internal(format!("transcription task failed: {e}")))?
}

#[cfg(not(target_os = "android"))]
fn model_status_impl(app: &AppHandle) -> CmdResult<u64> {
    // Count the finished model AND any half-finished `.part` — an interrupted
    // download strands the latter, and the delete button (which frees both)
    // is disabled while this reports 0.
    let dir = model_dir(app)?;
    let mut total = 0u64;
    for name in [
        crate::voice::transcribe::MODEL_FILE.to_string(),
        format!("{}.part", crate::voice::transcribe::MODEL_FILE),
    ] {
        total += std::fs::metadata(dir.join(&name))
            .map(|m| m.len())
            .unwrap_or(0);
    }
    Ok(total)
}

#[cfg(not(target_os = "android"))]
fn delete_model_impl(app: &AppHandle) -> CmdResult<u64> {
    let dir = model_dir(app)?;
    let mut freed = 0u64;
    for name in [
        crate::voice::transcribe::MODEL_FILE.to_string(),
        format!("{}.part", crate::voice::transcribe::MODEL_FILE),
    ] {
        let path = dir.join(&name);
        // A missing file is fine — deletion is idempotent.
        if let Ok(m) = std::fs::metadata(&path) {
            std::fs::remove_file(&path)
                .map_err(|e| CommandError::internal(format!("cannot delete the model: {e}")))?;
            freed += m.len();
        }
    }
    Ok(freed)
}

/// `app-data/voice/` — where finalized recordings are written.
#[cfg(not(target_os = "android"))]
fn voice_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::internal(format!("cannot resolve app data dir: {e}")))?
        .join("voice");
    std::fs::create_dir_all(&dir)
        .map_err(|e| CommandError::internal(format!("cannot create the voice dir: {e}")))?;
    Ok(dir)
}

/// `app-data/voice/models/` — where the whisper weights cache.
#[cfg(not(target_os = "android"))]
fn model_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::internal(format!("cannot resolve app data dir: {e}")))?
        .join("voice")
        .join("models"))
}

// ── Android stubs (no mic-capture story yet) ────────────────────────────────

#[cfg(target_os = "android")]
fn unavailable() -> CommandError {
    CommandError {
        kind: "voiceUnavailable".to_string(),
        message: "voice capture isn't available on this platform".to_string(),
    }
}

#[cfg(target_os = "android")]
fn start_impl() -> CmdResult<()> {
    Err(unavailable())
}

#[cfg(target_os = "android")]
async fn stop_impl(_app: &AppHandle) -> CmdResult<VoiceRecording> {
    Err(unavailable())
}

#[cfg(target_os = "android")]
fn cancel_impl() -> CmdResult<()> {
    Err(unavailable())
}

#[cfg(target_os = "android")]
fn delete_impl(_app: &AppHandle, _file_name: &str) -> CmdResult<()> {
    Err(unavailable())
}

#[cfg(target_os = "android")]
async fn transcribe_impl(_app: AppHandle, _wav_path: String) -> CmdResult<String> {
    Err(unavailable())
}

#[cfg(target_os = "android")]
fn model_status_impl(_app: &AppHandle) -> CmdResult<u64> {
    Ok(0)
}

#[cfg(target_os = "android")]
fn delete_model_impl(_app: &AppHandle) -> CmdResult<u64> {
    Ok(0)
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::is_recording_file_name;

    #[test]
    fn accepts_exactly_the_names_stop_impl_produces() {
        let name = format!("recording-{}.wav", uuid::Uuid::new_v4());
        assert!(is_recording_file_name(&name));
    }

    #[test]
    fn rejects_traversal_and_separators() {
        let uuid = uuid::Uuid::new_v4();
        for name in [
            format!("../recording-{uuid}.wav"),
            format!("..\\recording-{uuid}.wav"),
            format!("sub/recording-{uuid}.wav"),
            format!("/etc/recording-{uuid}.wav"),
            format!("recording-{uuid}.wav/.."),
            "recording-../../secret.wav".to_string(),
            "..".to_string(),
        ] {
            assert!(!is_recording_file_name(&name), "accepted: {name}");
        }
    }

    #[test]
    fn rejects_non_recording_names() {
        let uuid = uuid::Uuid::new_v4();
        for name in [
            "ggml-base.en.bin".to_string(),
            "recording-notauuid.wav".to_string(),
            format!("recording-{uuid}.wav.bak"),
            format!("recording-{uuid}.mp3"),
            format!("take-{uuid}.wav"),
            String::new(),
        ] {
            assert!(!is_recording_file_name(&name), "accepted: {name}");
        }
    }
}
