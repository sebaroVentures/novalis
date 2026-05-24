//! Plain data types shared across the core and exported to TypeScript via
//! `specta`. Every public type that crosses the IPC boundary derives
//! [`specta::Type`] so the frontend bindings stay in lockstep with Rust.

pub mod note;
pub mod preferences;
pub mod search;
pub mod template;
pub mod vault;

pub use note::*;
pub use preferences::*;
pub use search::*;
pub use template::*;
pub use vault::*;

use serde::{Deserialize, Serialize};
use specta::Type;

/// Basic app/build information surfaced to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}
