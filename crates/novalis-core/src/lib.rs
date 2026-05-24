//! # novalis-core
//!
//! UI-agnostic logic for Novalis. This crate knows nothing about Tauri, HTTP,
//! windows, or the filesystem location of the app — it operates on paths and
//! connections handed to it, which keeps it unit-testable in isolation and
//! reusable across desktop and (later) mobile shells.
//!
//! Modules are added milestone by milestone: `vault`, `index`, `notes`,
//! `tasks`, `calendar`, `conflict`, `export`, `trash`, `change`. For M0 only
//! the foundations (`error`, `models`) exist.

pub mod error;
pub mod models;

pub use error::{CoreError, CoreResult};
pub use models::AppInfo;

/// The core crate version (from `Cargo.toml`).
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Build the [`AppInfo`] payload. Exposed by the desktop shell as a Tauri
/// command; the simplest possible end-to-end path through the core.
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
