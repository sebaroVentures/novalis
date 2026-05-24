//! Core error type. Deliberately free of any UI/transport concern — the Tauri
//! command layer maps [`CoreError`] onto a serializable command error.

use thiserror::Error;

pub type CoreResult<T> = Result<T, CoreError>;

/// All failures the core can produce. Variants mirror the HTTP status buckets
/// the original module used (`errors.rs`), minus the `axum::IntoResponse` impl.
#[derive(Debug, Error)]
pub enum CoreError {
    #[error("not found: {0}")]
    NotFound(String),

    #[error("already exists: {0}")]
    AlreadyExists(String),

    #[error("bad request: {0}")]
    BadRequest(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serde(String),

    #[error("{0}")]
    Internal(String),
}

impl From<serde_json::Error> for CoreError {
    fn from(e: serde_json::Error) -> Self {
        CoreError::Serde(e.to_string())
    }
}
