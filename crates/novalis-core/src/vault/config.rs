//! Vault path / data-dir helpers and per-vault preferences.
//!
//! The vault path itself comes from the app's settings store (resolved in the
//! Tauri shell), not from environment variables. Per-vault preferences live in
//! a hidden `.novalis/` folder inside the vault (Obsidian-style, synced),
//! while the search index and trash live in the OS app-data `data_dir`
//! (never synced).

use std::path::{Path, PathBuf};

use crate::error::{CoreError, CoreResult};
use crate::models::Preferences;

/// Per-vault config folder (synced with the vault).
pub const CONFIG_DIR: &str = ".novalis";
/// Preferences file inside [`CONFIG_DIR`].
pub const PREFS_FILE: &str = "config.json";

/// Ensure the vault directory exists, creating it if necessary.
pub fn ensure_vault_dir(path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        std::fs::create_dir_all(path)?;
        log::info!("created vault directory at {}", path.display());
    }
    Ok(())
}

/// Ensure the app-data support dirs exist (`trash`, `templates`, `db`).
pub fn ensure_data_dirs(data_dir: &Path) -> std::io::Result<()> {
    for d in ["trash", "templates", "db"] {
        let p = data_dir.join(d);
        if !p.exists() {
            std::fs::create_dir_all(&p)?;
        }
    }
    Ok(())
}

/// Path to the SQLite index database within `data_dir`.
pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("db").join("notes.db")
}

/// The `.novalis/` config directory inside a vault.
pub fn config_dir(vault: &Path) -> PathBuf {
    vault.join(CONFIG_DIR)
}

fn prefs_path(vault: &Path) -> PathBuf {
    config_dir(vault).join(PREFS_FILE)
}

/// Read preferences from `<vault>/.novalis/config.json`, defaulting if missing
/// or unparseable.
pub fn read_preferences(vault: &Path) -> Preferences {
    match std::fs::read_to_string(prefs_path(vault)) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
        Err(_) => Preferences::default(),
    }
}

/// Write preferences to `<vault>/.novalis/config.json`, creating the dir.
pub fn write_preferences(vault: &Path, prefs: &Preferences) -> CoreResult<()> {
    let dir = config_dir(vault);
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(prefs).map_err(|e| CoreError::Serde(e.to_string()))?;
    std::fs::write(dir.join(PREFS_FILE), json)?;
    Ok(())
}
