//! API-key storage for AI connections in the OS keychain. Mirrors the git-token
//! storage in [`crate::commands`]: keys are stored under the shared
//! [`KEYRING_SERVICE`] keyed by `ai:<connection_id>`, and the key value never
//! crosses the IPC boundary back to the frontend.

use crate::engine::CommandError;
use crate::oauth::KEYRING_SERVICE;

fn entry(id: &str) -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("ai:{id}"))
        .map_err(|e| CommandError::internal(format!("keychain: {e}")))
}

/// Store the key, or remove it when `key` is blank.
pub fn set_key(id: &str, key: &str) -> Result<(), CommandError> {
    let entry = entry(id)?;
    let key = key.trim();
    if key.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(CommandError::internal(format!("keychain: {e}"))),
        }
    } else {
        entry
            .set_password(key)
            .map_err(|e| CommandError::internal(format!("keychain: {e}")))
    }
}

/// Remove any stored key for `id`.
pub fn clear_key(id: &str) -> Result<(), CommandError> {
    set_key(id, "")
}

/// Read the stored key for `id`, if any. Never exposed over IPC.
pub fn read_key(id: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("ai:{id}"))
        .ok()?
        .get_password()
        .ok()
}

/// Whether a key is stored for `id`.
pub fn has_key(id: &str) -> bool {
    read_key(id).is_some()
}
