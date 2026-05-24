//! Minimal app settings persisted as JSON in the OS app-config dir. For now it
//! only remembers the last opened vault so the app reopens it on launch.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    last_vault: Option<String>,
}

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

/// The most recently opened vault path, if any.
pub fn load_last_vault(app: &AppHandle) -> Option<String> {
    let contents = std::fs::read_to_string(settings_file(app)?).ok()?;
    serde_json::from_str::<Settings>(&contents).ok()?.last_vault
}

/// Remember `vault` as the last opened vault.
pub fn save_last_vault(app: &AppHandle, vault: &str) {
    let Some(path) = settings_file(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let settings = Settings {
        last_vault: Some(vault.to_string()),
    };
    if let Ok(json) = serde_json::to_string_pretty(&settings) {
        let _ = std::fs::write(path, json);
    }
}
