//! Minimal app settings persisted as JSON in the OS app-config dir. Remembers
//! the last opened vault (reopened on launch) and a short recent-vaults list so
//! the user can switch between locations. This is the only state that lives
//! *outside* any vault, so it survives a vault switch.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager};

use novalis_core::models::{AiConnectionConfig, AiEmbeddingConfig};

/// How many recent vault locations to remember.
const RECENT_LIMIT: usize = 10;

/// Serializes the read-modify-write of settings.json across threads (the startup
/// reopen thread vs. user actions), so concurrent writers can't lose updates.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// An entry in the recent-vaults list (most-recent first in the stored list).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentVault {
    /// Absolute path to the vault folder.
    pub path: String,
    /// Epoch milliseconds of the last time this vault was opened.
    pub last_opened: i64,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    last_vault: Option<String>,
    // `default` keeps older settings.json files (which only had `last_vault`)
    // parseable after the upgrade.
    #[serde(default)]
    recent_vaults: Vec<RecentVault>,
    // AI connection configs are user/machine-level (keys live in the OS
    // keychain), so they belong here rather than in the git-synced vault prefs.
    #[serde(default)]
    ai_connections: Vec<AiConnectionConfig>,
    // Which connection + model produce note embeddings (the semantic index).
    // References an `ai_connections` entry by id; never holds a secret.
    #[serde(default)]
    ai_embedding: Option<AiEmbeddingConfig>,
}

fn settings_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

/// Load the whole settings struct (defaults if missing/unparseable). Callers
/// read-modify-write the full struct so no field clobbers another.
fn load(app: &AppHandle) -> Settings {
    let Some(path) = settings_file(app) else {
        return Settings::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

/// Persist the whole settings struct atomically (write a sibling temp file then
/// rename over the target), so a crash or overlapping write never leaves a
/// half-written settings.json behind.
fn save(app: &AppHandle, settings: &Settings) {
    let Some(path) = settings_file(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(json) = serde_json::to_string_pretty(settings) else {
        return;
    };
    let tmp = path.with_file_name("settings.json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// The most recently opened vault path, if any.
pub fn load_last_vault(app: &AppHandle) -> Option<String> {
    load(app).last_vault
}

/// Remember `vault` as the last opened vault. Read-modify-write so it never
/// clobbers `recent_vaults`.
pub fn save_last_vault(app: &AppHandle, vault: &str) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = load(app);
    settings.last_vault = Some(vault.to_string());
    save(app, &settings);
}

/// Insert/refresh `vault` at the front of `list`: dedupe by path, stamp the open
/// time, and cap the length. Pure so the ordering/cap logic is unit-testable.
fn upsert_recent(list: &mut Vec<RecentVault>, vault: &str, now_ms: i64) {
    list.retain(|v| v.path != vault);
    list.insert(
        0,
        RecentVault {
            path: vault.to_string(),
            last_opened: now_ms,
        },
    );
    list.truncate(RECENT_LIMIT);
}

/// Record `vault` in the recent list (most-recent first).
pub fn push_recent_vault(app: &AppHandle, vault: &str, now_ms: i64) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = load(app);
    upsert_recent(&mut settings.recent_vaults, vault, now_ms);
    save(app, &settings);
}

/// The recent-vaults list, most-recent first.
pub fn list_recent_vaults(app: &AppHandle) -> Vec<RecentVault> {
    load(app).recent_vaults
}

/// Remove a vault from the recent list (e.g. when its folder is gone).
pub fn remove_recent_vault(app: &AppHandle, vault: &str) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = load(app);
    settings.recent_vaults.retain(|v| v.path != vault);
    save(app, &settings);
}

/// All stored AI connection configs (non-secret; keys live in the keychain).
pub fn load_ai_connections(app: &AppHandle) -> Vec<AiConnectionConfig> {
    load(app).ai_connections
}

/// Insert or replace a connection by `id`. Read-modify-write so it never
/// clobbers `last_vault`/`recent_vaults`.
pub fn upsert_ai_connection(app: &AppHandle, conn: AiConnectionConfig) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = load(app);
    if let Some(existing) = settings.ai_connections.iter_mut().find(|c| c.id == conn.id) {
        *existing = conn;
    } else {
        settings.ai_connections.push(conn);
    }
    save(app, &settings);
}

/// Remove a connection config by `id`. Also drops the embedding config if it
/// referenced this connection, so a dangling reference can't linger.
pub fn delete_ai_connection(app: &AppHandle, id: &str) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = load(app);
    settings.ai_connections.retain(|c| c.id != id);
    if settings
        .ai_embedding
        .as_ref()
        .is_some_and(|e| e.connection_id == id)
    {
        settings.ai_embedding = None;
    }
    save(app, &settings);
}

/// The embedding config (which connection + model), if set.
pub fn load_ai_embedding(app: &AppHandle) -> Option<AiEmbeddingConfig> {
    load(app).ai_embedding
}

/// Set or clear the embedding config. Read-modify-write so it never clobbers
/// connections / last_vault / recent_vaults.
pub fn set_ai_embedding(app: &AppHandle, cfg: Option<AiEmbeddingConfig>) {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut settings = load(app);
    settings.ai_embedding = cfg;
    save(app, &settings);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_dedupes_and_moves_to_front() {
        let mut list = vec![
            RecentVault {
                path: "/a".into(),
                last_opened: 1,
            },
            RecentVault {
                path: "/b".into(),
                last_opened: 2,
            },
        ];
        upsert_recent(&mut list, "/b", 99);
        assert_eq!(list.len(), 2, "dedupes by path, no duplicate /b");
        assert_eq!(list[0].path, "/b", "re-opened vault moves to front");
        assert_eq!(list[0].last_opened, 99, "open time is refreshed");
        assert_eq!(list[1].path, "/a");
    }

    #[test]
    fn upsert_prepends_new_entries() {
        let mut list = vec![RecentVault {
            path: "/a".into(),
            last_opened: 1,
        }];
        upsert_recent(&mut list, "/c", 5);
        assert_eq!(list[0].path, "/c");
        assert_eq!(list[1].path, "/a");
    }

    #[test]
    fn upsert_caps_at_limit() {
        let mut list = Vec::new();
        for i in 0..(RECENT_LIMIT + 5) {
            upsert_recent(&mut list, &format!("/v{i}"), i as i64);
        }
        assert_eq!(list.len(), RECENT_LIMIT, "list is capped");
        // The most recently inserted is first; the oldest fell off the end.
        assert_eq!(list[0].path, format!("/v{}", RECENT_LIMIT + 4));
    }
}
