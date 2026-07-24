//! # novalis-core
//!
//! UI-agnostic logic for Novalis. This crate knows nothing about Tauri, HTTP,
//! windows, or where the app stores its data — it operates on paths and
//! database connections handed to it, which keeps it unit-testable in
//! isolation and reusable across the desktop and (later) mobile shells.

pub mod ai;
pub mod calendar;
pub mod change;
pub mod conflict;
pub mod error;
pub mod export;
pub mod git;
pub mod help_demo;
pub mod import;
pub mod index;
pub mod media;
pub mod models;
pub mod notes;
pub mod pdf;
pub mod plugins;
pub mod review;
pub mod sync;
pub mod tasks;
pub mod templates;
pub mod tour;
pub mod trash;
pub mod vault;
pub mod versions;

pub use error::{CoreError, CoreResult};
pub use models::AppInfo;

/// The core crate version (from `Cargo.toml`).
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Build the [`AppInfo`] payload. Exposed by the desktop shell as a Tauri
/// command; the simplest end-to-end path through the core.
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "Novalis".to_string(),
        version: version().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_nonempty() {
        assert!(!version().is_empty());
    }

    #[test]
    fn app_info_reports_name_and_version() {
        let info = app_info();
        assert_eq!(info.name, "Novalis");
        assert_eq!(info.version, version());
    }
}
