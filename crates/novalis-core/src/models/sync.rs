//! IPC-facing types for the P2P sync backend (W4.4), exported to TypeScript via
//! `specta`. These carry only non-secret status/summary data — the vault key
//! and device seed never cross this boundary (they live in the keychain, and
//! the pairing ticket is returned as an opaque encoded string).

use serde::{Deserialize, Serialize};
use specta::Type;

/// Snapshot of the P2P sync backend for the settings panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    /// Whether sync has been set up for this vault (a device identity + vault
    /// key + vault id exist). `false` = the panel shows the "get started" state.
    pub configured: bool,
    /// This device's node id (hex), once the endpoint exists.
    pub node_id: Option<String>,
    /// The shared logical vault id, once configured.
    pub vault_id: Option<String>,
    /// Number of paired peer devices.
    pub peer_count: u32,
    /// Whether the local QUIC endpoint is up and accepting connections.
    pub listening: bool,
    /// Paired peers (non-secret summary).
    pub peers: Vec<SyncPeerInfo>,
}

/// A paired peer, as shown in the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncPeerInfo {
    pub node_id: String,
    pub label: String,
    pub last_synced_ms: Option<i64>,
}

/// What one P2P sync cycle did. Mirrors the shape of git's `GitSyncOutcome`:
/// counts plus a conflict list the existing conflict UI surfaces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    pub kind: SyncOutcomeKind,
    /// Files written locally from a peer this cycle.
    pub taken: u32,
    /// Files sent to a peer this cycle.
    pub sent: u32,
    /// Vault-relative paths that diverged (both sides edited): the peer's
    /// version was written as a conflict copy for the existing resolver to
    /// surface. Empty on a clean sync.
    pub conflicts: Vec<String>,
    /// Deletions detected but deliberately NOT propagated in this foundation
    /// (see `FileAction::DeletePending`). Surfaced so the boundary is visible.
    pub unsynced_deletes: u32,
    /// Files skipped this cycle because they exceed the per-file transfer cap
    /// (the 64 MiB frame limit). Counted and logged, never fatal; they retry
    /// (and are skipped again) until they shrink or a chunked transfer lands.
    pub skipped_oversize: u32,
}

/// Externally tagged like `GitSyncKind`: unit variants cross IPC as plain
/// strings (`"upToDate"`), so the TS side can `switch` on them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SyncOutcomeKind {
    /// Sync ran and both peers converged (files may have transferred).
    Synced,
    /// Nothing to transfer with any peer.
    UpToDate,
    /// No peers are paired yet.
    NoPeers,
    /// Sync isn't set up for this vault.
    NotConfigured,
    /// A peer was unreachable this cycle (offline / NAT). Non-fatal: the next
    /// attempt retries.
    PeerUnreachable,
}
