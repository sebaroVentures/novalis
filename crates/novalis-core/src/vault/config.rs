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

/// Ensure the app-data support dirs exist (`templates`, `db`). Trash now lives
/// inside the vault (`.novalis/trash`); `versions/` is created lazily on save.
pub fn ensure_data_dirs(data_dir: &Path) -> std::io::Result<()> {
    for d in ["templates", "db"] {
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

/// Read preferences from `<vault>/.novalis/config.json`. A missing file is
/// legitimate (fresh vault) and yields defaults; an unreadable or malformed
/// file is an error — silently defaulting here meant one bad edit plus any
/// later [`write_preferences`] permanently replaced the user's file.
pub fn try_read_preferences(vault: &Path) -> CoreResult<Preferences> {
    let path = prefs_path(vault);
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|e| CoreError::Serde(format!("{}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(e) => Err(e.into()),
    }
}

/// Shim for callers that cannot surface errors: failures are logged and fall
/// back to defaults. Prefer [`try_read_preferences`].
#[deprecated(note = "use try_read_preferences — this swallows parse errors")]
pub fn read_preferences(vault: &Path) -> Preferences {
    try_read_preferences(vault).unwrap_or_else(|e| {
        log::warn!("read_preferences: falling back to defaults: {e}");
        Preferences::default()
    })
}

/// Write preferences to `<vault>/.novalis/config.json`, creating the dir.
pub fn write_preferences(vault: &Path, prefs: &Preferences) -> CoreResult<()> {
    let dir = config_dir(vault);
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(prefs).map_err(|e| CoreError::Serde(e.to_string()))?;
    crate::vault::fs::write_atomic(&dir.join(PREFS_FILE), &json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_prefs_file_yields_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let prefs = try_read_preferences(dir.path()).unwrap();
        assert_eq!(
            serde_json::to_value(&prefs).unwrap(),
            serde_json::to_value(Preferences::default()).unwrap()
        );
    }

    #[test]
    fn malformed_prefs_file_is_an_error_not_a_silent_default() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config_dir(dir.path());
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(cfg.join(PREFS_FILE), "{ not json").unwrap();
        let err = try_read_preferences(dir.path()).unwrap_err();
        assert!(matches!(err, CoreError::Serde(_)), "got: {err:?}");
    }
}
