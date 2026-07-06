//! The desktop shell's runtime state: an open vault plus its SQLite index
//! connection, guarded by a mutex and managed by Tauri. Commands borrow the
//! [`Engine`] through [`AppEngine::with`] and call into `novalis_core`.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;
use specta::Type;

use novalis_core::CoreError;

/// An open vault: its path, the app-data location for derived state, and the
/// live index connection.
pub struct Engine {
    pub db: Connection,
    pub vault_path: PathBuf,
    pub data_dir: PathBuf,
}

/// Tauri-managed state. `None` until a vault is opened.
#[derive(Default)]
pub struct AppEngine(pub Mutex<Option<Engine>>);

impl AppEngine {
    /// Run `f` against the open engine, mapping errors to [`CommandError`].
    /// Returns a `noVault` error if no vault is currently open.
    pub fn with<F, R>(&self, f: F) -> Result<R, CommandError>
    where
        F: FnOnce(&Engine) -> Result<R, CoreError>,
    {
        // Recover from poisoning: a command that panicked mid-call can't leave
        // the `Option<Engine>` half-updated, so the state is still sound — and
        // erroring forever would brick every later command until restart.
        let guard = self.0.lock().unwrap_or_else(|p| p.into_inner());
        let engine = guard.as_ref().ok_or_else(CommandError::no_vault)?;
        f(engine).map_err(CommandError::from)
    }
}

/// Serializable error returned to the frontend. `kind` lets the UI branch
/// (e.g. show an "open a vault" prompt for `noVault`).
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub kind: String,
    pub message: String,
}

impl CommandError {
    pub fn internal(msg: impl Into<String>) -> Self {
        Self {
            kind: "internal".to_string(),
            message: msg.into(),
        }
    }

    pub fn no_vault() -> Self {
        Self {
            kind: "noVault".to_string(),
            message: "No vault is open".to_string(),
        }
    }
}

impl From<CoreError> for CommandError {
    fn from(e: CoreError) -> Self {
        let kind = match &e {
            CoreError::NotFound(_) => "notFound",
            CoreError::AlreadyExists(_) => "alreadyExists",
            CoreError::BadRequest(_) => "badRequest",
            _ => "internal",
        };
        Self {
            kind: kind.to_string(),
            message: e.to_string(),
        }
    }
}
