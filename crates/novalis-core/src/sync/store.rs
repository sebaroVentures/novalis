//! On-disk state for P2P sync: the vault's stable id and the list of paired
//! peers, plus the per-peer **base manifest** (the last-synced snapshot the
//! 3-way [`plan`](super::manifest::plan) needs).
//!
//! ## Where this lives (deliberately)
//! Not in the vault (it's device-local: which peers *this* device paired with),
//! and **not** in the disposable index cache — losing it must not lose your
//! pairings. The desktop shell hands us a directory under the per-vault
//! app-data location. Secrets (the device seed, the vault key) are NOT here —
//! those go to the OS keychain; this file holds only non-secret metadata
//! (ids, node ids, address hints), so it is safe at rest.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::sync::manifest::Manifest;
use crate::vault::fs::write_atomic;

/// Basename of the sync state file inside the sync directory.
const STORE_FILE: &str = "sync.json";

/// A paired peer device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerRecord {
    /// Hex node id (the peer's ed25519 public key / iroh node id).
    pub node_id: String,
    /// Human label (defaults to a short fingerprint at pairing time).
    pub label: String,
    /// Optional relay URL learned from the pairing ticket.
    #[serde(default)]
    pub relay: Option<String>,
    /// Direct address hints learned from the ticket.
    #[serde(default)]
    pub addrs: Vec<String>,
    /// Epoch-ms of the last successful sync with this peer, if any.
    #[serde(default)]
    pub last_synced_ms: Option<i64>,
}

/// The persisted sync state for one vault.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStore {
    /// Stable logical id of this vault; both paired devices agree on it. Empty
    /// until sync is first set up (generating a ticket, or joining one).
    #[serde(default)]
    pub vault_id: String,
    #[serde(default)]
    pub peers: Vec<PeerRecord>,
}

impl SyncStore {
    /// Load the store from `dir/sync.json`, or a fresh default if absent /
    /// unparseable (a corrupt file must not brick sync setup — the worst case
    /// is re-pairing).
    pub fn load(dir: &Path) -> SyncStore {
        let path = dir.join(STORE_FILE);
        match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
                log::warn!("sync: unreadable sync store, starting fresh: {e}");
                SyncStore::default()
            }),
            Err(_) => SyncStore::default(),
        }
    }

    /// Persist atomically to `dir/sync.json` (creating `dir` if needed).
    pub fn save(&self, dir: &Path) -> CoreResult<()> {
        std::fs::create_dir_all(dir)?;
        let json = serde_json::to_string_pretty(self)?;
        write_atomic(&dir.join(STORE_FILE), &json)
    }

    /// Ensure a vault id exists, generating one if this is the first setup.
    /// Returns the id.
    pub fn ensure_vault_id(&mut self) -> String {
        if self.vault_id.trim().is_empty() {
            self.vault_id = uuid::Uuid::new_v4().to_string();
        }
        self.vault_id.clone()
    }

    /// Insert or update a peer by node id (idempotent pairing).
    pub fn upsert_peer(&mut self, peer: PeerRecord) {
        match self.peers.iter_mut().find(|p| p.node_id == peer.node_id) {
            Some(existing) => {
                // Preserve last_synced_ms unless the incoming record carries a
                // newer one; refresh the reachability hints and label.
                existing.label = peer.label;
                existing.relay = peer.relay;
                existing.addrs = peer.addrs;
                if peer.last_synced_ms.is_some() {
                    existing.last_synced_ms = peer.last_synced_ms;
                }
            }
            None => self.peers.push(peer),
        }
    }

    /// Record a successful sync time for a peer.
    pub fn mark_synced(&mut self, node_id: &str, when_ms: i64) {
        if let Some(p) = self.peers.iter_mut().find(|p| p.node_id == node_id) {
            p.last_synced_ms = Some(when_ms);
        }
    }
}

/// Path of the base-manifest file for a given peer (kept separate from the main
/// store so a large manifest doesn't bloat every read of the peer list).
fn base_manifest_path(dir: &Path, node_id: &str) -> PathBuf {
    // node ids are hex, so they're already filesystem-safe.
    dir.join(format!("base-{node_id}.json"))
}

/// Load the last-synced base manifest for a peer, or an empty manifest (first
/// sync) if none exists.
pub fn load_base_manifest(dir: &Path, node_id: &str) -> Manifest {
    match std::fs::read_to_string(base_manifest_path(dir, node_id)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Manifest::default(),
    }
}

/// Persist the base manifest for a peer after a successful sync.
pub fn save_base_manifest(dir: &Path, node_id: &str, manifest: &Manifest) -> CoreResult<()> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_string(manifest)
        .map_err(|e| CoreError::Serde(format!("sync: base manifest encode: {e}")))?;
    write_atomic(&base_manifest_path(dir, node_id), &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(node: &str) -> PeerRecord {
        PeerRecord {
            node_id: node.to_string(),
            label: node.to_string(),
            relay: None,
            addrs: vec![],
            last_synced_ms: None,
        }
    }

    #[test]
    fn ensure_vault_id_is_stable_across_calls() {
        let mut s = SyncStore::default();
        let first = s.ensure_vault_id();
        assert!(!first.is_empty());
        assert_eq!(first, s.ensure_vault_id(), "second call keeps the same id");
    }

    #[test]
    fn upsert_is_idempotent_and_updates_hints() {
        let mut s = SyncStore::default();
        s.upsert_peer(peer("aa"));
        let mut updated = peer("aa");
        updated.addrs = vec!["1.2.3.4:9".to_string()];
        s.upsert_peer(updated);
        assert_eq!(s.peers.len(), 1);
        assert_eq!(s.peers[0].addrs, vec!["1.2.3.4:9"]);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = SyncStore::default();
        s.ensure_vault_id();
        s.upsert_peer(peer("bb"));
        s.save(dir.path()).unwrap();

        let loaded = SyncStore::load(dir.path());
        assert_eq!(loaded.vault_id, s.vault_id);
        assert_eq!(loaded.peers.len(), 1);
        assert_eq!(loaded.peers[0].node_id, "bb");
    }

    #[test]
    fn load_missing_is_default_not_error() {
        let dir = tempfile::tempdir().unwrap();
        let loaded = SyncStore::load(dir.path());
        assert!(loaded.vault_id.is_empty());
        assert!(loaded.peers.is_empty());
    }

    #[test]
    fn mark_synced_sets_timestamp() {
        let mut s = SyncStore::default();
        s.upsert_peer(peer("cc"));
        s.mark_synced("cc", 12345);
        assert_eq!(s.peers[0].last_synced_ms, Some(12345));
    }

    #[test]
    fn base_manifest_round_trips_per_peer() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_base_manifest(dir.path(), "dd"), Manifest::default());

        let mut m = Manifest::default();
        m.entries.insert(
            "a.md".to_string(),
            crate::sync::manifest::FileEntry {
                path: "a.md".to_string(),
                hash: "abc".to_string(),
                size: 1,
                mtime_ms: 0,
            },
        );
        save_base_manifest(dir.path(), "dd", &m).unwrap();
        assert_eq!(load_base_manifest(dir.path(), "dd"), m);
    }
}
