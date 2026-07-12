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
#[tauri::command]
#[specta::specta]
pub fn voice_stop_recording(app: AppHandle) -> CmdResult<VoiceRecording> {
    stop_impl(&app)
}

/// Transcribe a recorded WAV on-device. Downloads + caches the whisper model on
/// first use; runs off the async runtime (whisper is CPU-bound and blocking).
#[tauri::command]
#[specta::specta]
pub async fn voice_transcribe(app: AppHandle, wav_path: String) -> CmdResult<String> {
    transcribe_impl(app, wav_path).await
}

// ── Desktop implementation ──────────────────────────────────────────────────

#[cfg(not(target_os = "android"))]
fn start_impl() -> CmdResult<()> {
    crate::voice::capture::start()
}

#[cfg(not(target_os = "android"))]
fn stop_impl(app: &AppHandle) -> CmdResult<VoiceRecording> {
    let dir = voice_dir(app)?;
    let path = dir.join(format!("recording-{}.wav", uuid::Uuid::new_v4()));
    let rec = crate::voice::capture::stop(&path)?;
    Ok(VoiceRecording {
        path: rec.path.to_string_lossy().to_string(),
        duration_secs: rec.duration_secs,
    })
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
fn stop_impl(_app: &AppHandle) -> CmdResult<VoiceRecording> {
    Err(unavailable())
}

#[cfg(target_os = "android")]
async fn transcribe_impl(_app: AppHandle, _wav_path: String) -> CmdResult<String> {
    Err(unavailable())
}
