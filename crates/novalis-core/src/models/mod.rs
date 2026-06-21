//! Plain data types shared across the core and exported to TypeScript via
//! `specta`. Every public type that crosses the IPC boundary derives
//! [`specta::Type`] so the frontend bindings stay in lockstep with Rust.

pub mod ai;
pub mod calendar;
pub mod git;
pub mod note;
pub mod plugin;
pub mod preferences;
pub mod search;
pub mod task;
pub mod template;
pub mod vault;

pub use ai::*;
pub use calendar::*;
pub use git::*;
pub use note::*;
pub use plugin::*;
pub use preferences::*;
pub use search::*;
pub use task::*;
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
