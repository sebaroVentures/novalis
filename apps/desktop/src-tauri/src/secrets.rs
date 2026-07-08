//! Secret storage behind one API, keyed by account strings (`ai:<id>`,
//! `oauth:<provider>`, `git:<vault>`). Values never cross the IPC boundary.
//!
//! Desktop backends use the OS keychain via the `keyring` crate. Android has
//! no `keyring` backend — the alpha tradeoff (documented in MOBILE.md) is a
//! JSON file inside the app-private data dir (OS-sandboxed per app, not
//! synced, not in the vault). Upgrade path: an Android-Keystore plugin.

use crate::engine::CommandError;

/// Keychain service name shared by every stored secret (desktop keyring
/// backends only — the Android file store has no service concept).
#[cfg(not(target_os = "android"))]
pub(crate) const KEYRING_SERVICE: &str = "app.novalis";

/// Store `value` under `account`; a blank value removes the entry.
pub(crate) fn set(account: &str, value: &str) -> Result<(), CommandError> {
    let value = value.trim();
    if value.is_empty() {
        backend::delete(account)
    } else {
        backend::set(account, value)
    }
}

/// Read the secret stored under `account`, if any.
pub(crate) fn get(account: &str) -> Option<String> {
    backend::get(account)
}

/// Remove any secret stored under `account`.
pub(crate) fn delete(account: &str) -> Result<(), CommandError> {
    backend::delete(account)
}

#[cfg(not(target_os = "android"))]
mod backend {
    use super::{CommandError, KEYRING_SERVICE};

    fn entry(account: &str) -> Result<keyring::Entry, CommandError> {
        keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|e| CommandError::internal(format!("keychain: {e}")))
    }

    pub fn set(account: &str, value: &str) -> Result<(), CommandError> {
        entry(account)?
            .set_password(value)
            .map_err(|e| CommandError::internal(format!("keychain: {e}")))
    }

    pub fn get(account: &str) -> Option<String> {
        entry(account).ok()?.get_password().ok()
    }

    pub fn delete(account: &str) -> Result<(), CommandError> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(CommandError::internal(format!("keychain: {e}"))),
        }
    }
}

#[cfg(target_os = "android")]
mod backend {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    use super::CommandError;

    /// App-private data dir, injected once at startup from the Tauri path
    /// resolver (there is no reliable way to find it from a free function).
    static STORE_DIR: OnceLock<PathBuf> = OnceLock::new();
    /// Serializes read-modify-write cycles on the store file.
    static STORE_LOCK: Mutex<()> = Mutex::new(());

    pub fn init(dir: PathBuf) {
        let _ = STORE_DIR.set(dir);
    }

    fn store_path() -> Result<PathBuf, CommandError> {
        STORE_DIR
            .get()
            .map(|d| d.join("secrets.json"))
            .ok_or_else(|| CommandError::internal("secret store not initialized"))
    }

    fn load(path: &PathBuf) -> BTreeMap<String, String> {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(path: &PathBuf, map: &BTreeMap<String, String>) -> Result<(), CommandError> {
        let json = serde_json::to_string(map)
            .map_err(|e| CommandError::internal(format!("secret store: {e}")))?;
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Same-dir temp + rename so a crash never truncates the store.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)
            .and_then(|()| std::fs::rename(&tmp, path))
            .map_err(|e| CommandError::internal(format!("secret store: {e}")))
    }

    pub fn set(account: &str, value: &str) -> Result<(), CommandError> {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let path = store_path()?;
        let mut map = load(&path);
        map.insert(account.to_string(), value.to_string());
        save(&path, &map)
    }

    pub fn get(account: &str) -> Option<String> {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let path = store_path().ok()?;
        load(&path).get(account).cloned()
    }

    pub fn delete(account: &str) -> Result<(), CommandError> {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let path = store_path()?;
        let mut map = load(&path);
        if map.remove(account).is_some() {
            save(&path, &map)?;
        }
        Ok(())
    }
}

/// Android only: point the file-backed store at the app-private data dir.
#[cfg(target_os = "android")]
pub(crate) fn init_store(dir: std::path::PathBuf) {
    backend::init(dir);
}

// No unit tests here on purpose: every backend needs a real OS secret store
// (headless CI Linux has no DBus secret-service, so even a delete of a
// nonexistent entry errors), and the Android file backend is compile-gated
// off on desktop hosts. The store is exercised through the commands that use
// it; the blank-value-deletes contract is three lines above.
