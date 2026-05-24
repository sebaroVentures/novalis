//! Plain data types shared across the core and exported to TypeScript via
//! `specta`. Every public type that crosses the IPC boundary derives
//! [`specta::Type`] so the frontend bindings stay in lockstep with Rust.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Basic app/build information surfaced to the UI. Acts as the M0 smoke-test
/// payload proving the Rust -> TS binding pipeline end-to-end.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}
