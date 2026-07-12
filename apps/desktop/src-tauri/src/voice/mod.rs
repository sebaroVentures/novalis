//! Native voice/meeting capture → on-device transcription → note + tasks (W4.3).
//!
//! A native shell can reach the OS microphone; a browser-sandboxed plugin
//! structurally cannot — that is the wedge this feature leans on. The pipeline
//! is: [`capture`] records the mic to a 16 kHz mono WAV in the app-data dir,
//! [`transcribe`] runs whisper.cpp on it fully on-device (privacy-first, no audio
//! ever leaves the machine), and the frontend then writes a transcript note and
//! runs the existing hidden `extract-tasks` action through its accept/reject
//! review flow. No new AI action, no schema change — the output is notes/tasks.
//!
//! ## Platform
//! The heavy native deps (`cpal`, `whisper-rs`) are desktop-only, gated off
//! Android exactly like the on-device embedder (`crate::ai::embed_local`) and the
//! keyring backend (`crate::secrets`). The [`commands`] module is always
//! compiled so the command/binding surface stays identical across targets; on
//! Android the command bodies return a clear "not available" error.

pub mod commands;

#[cfg(not(target_os = "android"))]
pub mod capture;
#[cfg(not(target_os = "android"))]
pub mod transcribe;
