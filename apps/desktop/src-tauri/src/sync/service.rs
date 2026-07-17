//! Service glue for P2P sync: bridges the Tauri command layer to the keychain
//! (device seed + vault key — the secrets that must never leave the device),
//! the on-disk sync store (vault id + peers + per-peer base manifest), and the
//! `iroh` transport.
//!
//! The four command-facing entry points ([`status`], [`generate_ticket`],
//! [`join`], [`sync_now`]) exist on every platform; the real implementations
//! are desktop-only (the transport is `iroh`, which — like `fastembed` and
//! `keyring` — is gated off mobile), with honest "desktop-only in this build"
//! stubs elsewhere.

pub(crate) use imp::{generate_ticket, join, status, sync_now};
#[cfg(desktop)]
pub(crate) use imp::{is_known_peer, register_peer, responder_ctx};

#[cfg(desktop)]
mod imp {
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    use novalis_core::models::{SyncOutcome, SyncOutcomeKind, SyncPeerInfo, SyncStatus};
    use novalis_core::sync::store::{self, PeerRecord, SyncStore};
    use novalis_core::sync::{DeviceIdentity, Manifest, SyncTicket, VaultKey};
    use novalis_core::{CoreError, CoreResult};
    use tauri::{AppHandle, Manager};

    use crate::engine::{AppEngine, CommandError};
    use crate::sync::endpoint;
    use crate::sync::session::{SessionCtx, SessionOutcome};

    /// Global keychain account for this device's identity seed (one node id per
    /// device, shared across vaults).
    const IDENTITY_ACCOUNT: &str = "sync-identity";

    fn vault_key_account(vault: &Path) -> String {
        format!("sync-vaultkey:{}", vault.display())
    }

    fn vault_and_data(app: &AppHandle) -> Result<(PathBuf, PathBuf), CommandError> {
        app.state::<AppEngine>()
            .with(|e| Ok((e.vault_path.clone(), e.data_dir.clone())))
    }

    /// Where the self-contained sync state lives — under the per-vault app-data
    /// dir, deliberately NOT in the vault and NOT in the disposable index cache.
    fn sync_dir(data_dir: &Path) -> PathBuf {
        data_dir.join("sync")
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn to_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn decode_hex32(hex: &str) -> Option<[u8; 32]> {
        let hex = hex.trim();
        if hex.len() != 64 {
            return None;
        }
        let mut out = [0u8; 32];
        for (i, b) in out.iter_mut().enumerate() {
            *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
        }
        Some(out)
    }

    /// Load-or-create the device identity, persisting its seed in the keychain.
    fn ensure_identity() -> Result<DeviceIdentity, CommandError> {
        if let Some(hex) = crate::secrets::get(IDENTITY_ACCOUNT) {
            if let Ok(id) = DeviceIdentity::from_hex(&hex) {
                return Ok(id);
            }
        }
        let id = DeviceIdentity::generate();
        crate::secrets::set(IDENTITY_ACCOUNT, &id.to_hex())?;
        Ok(id)
    }

    fn load_vault_key(vault: &Path) -> Option<VaultKey> {
        let hex = crate::secrets::get(&vault_key_account(vault))?;
        Some(VaultKey::from_bytes(decode_hex32(&hex)?))
    }

    /// Load-or-create this vault's E2E key, persisting it in the keychain.
    fn ensure_vault_key(vault: &Path) -> Result<VaultKey, CommandError> {
        if let Some(k) = load_vault_key(vault) {
            return Ok(k);
        }
        let key = VaultKey::generate();
        crate::secrets::set(&vault_key_account(vault), &to_hex(key.as_bytes()))?;
        Ok(key)
    }

    pub(crate) fn status(app: &AppHandle) -> Result<SyncStatus, CommandError> {
        let (vault, data) = vault_and_data(app)?;
        let dir = sync_dir(&data);
        let store = SyncStore::load(&dir);
        let has_key = load_vault_key(&vault).is_some();
        let configured = !store.vault_id.trim().is_empty() && has_key;
        let peers = store
            .peers
            .iter()
            .map(|p| SyncPeerInfo {
                node_id: p.node_id.clone(),
                label: p.label.clone(),
                last_synced_ms: p.last_synced_ms,
            })
            .collect::<Vec<_>>();
        Ok(SyncStatus {
            configured,
            node_id: endpoint::local_node_id_hex(),
            vault_id: (!store.vault_id.trim().is_empty()).then(|| store.vault_id.clone()),
            peer_count: peers.len() as u32,
            listening: endpoint::is_listening(),
            peers,
        })
    }

    pub(crate) async fn generate_ticket(app: &AppHandle) -> Result<String, CommandError> {
        let (vault, data) = vault_and_data(app)?;
        let dir = sync_dir(&data);
        let identity = ensure_identity()?;
        let key = ensure_vault_key(&vault)?;

        let mut store = SyncStore::load(&dir);
        let vault_id = store.ensure_vault_id();
        store
            .save(&dir)
            .map_err(|e| CommandError::internal(e.to_string()))?;

        // Bring the endpoint up so the ticket's node is reachable and we accept.
        endpoint::ensure_endpoint(*identity.seed(), app.clone())
            .await
            .map_err(CommandError::from)?;
        let (node_hex, addrs) = endpoint::local_reachability()
            .ok_or_else(|| CommandError::internal("sync: endpoint not ready"))?;
        let node_id = decode_hex32(&node_hex)
            .ok_or_else(|| CommandError::internal("sync: bad local node id"))?;

        let ticket = SyncTicket {
            vault_id,
            node_id,
            relay_url: None,
            direct_addrs: addrs,
            vault_key: key,
        };
        ticket.encode().map_err(CommandError::from)
    }

    pub(crate) async fn join(app: &AppHandle, ticket_str: String) -> Result<(), CommandError> {
        let ticket = SyncTicket::decode(&ticket_str).map_err(CommandError::from)?;
        let (vault, data) = vault_and_data(app)?;
        let dir = sync_dir(&data);

        let mut store = SyncStore::load(&dir);
        store.vault_id = reconcile_vault_id(&store.vault_id, &ticket.vault_id)?;

        // Store the shared vault key so we can decrypt this vault's files.
        crate::secrets::set(
            &vault_key_account(&vault),
            &to_hex(ticket.vault_key.as_bytes()),
        )?;

        let node_hex = to_hex(&ticket.node_id);
        store.upsert_peer(PeerRecord {
            node_id: node_hex.clone(),
            label: node_hex.chars().take(8).collect(),
            relay: ticket.relay_url.clone(),
            addrs: ticket.direct_addrs.clone(),
            last_synced_ms: None,
        });
        store
            .save(&dir)
            .map_err(|e| CommandError::internal(e.to_string()))?;

        // Come online so we can be dialed and can dial.
        let identity = ensure_identity()?;
        endpoint::ensure_endpoint(*identity.seed(), app.clone())
            .await
            .map_err(CommandError::from)?;
        Ok(())
    }

    pub(crate) async fn sync_now(app: &AppHandle) -> Result<SyncOutcome, CommandError> {
        let (vault, data) = vault_and_data(app)?;
        let dir = sync_dir(&data);
        let mut store = SyncStore::load(&dir);

        let mut outcome = SyncOutcome {
            kind: SyncOutcomeKind::UpToDate,
            taken: 0,
            sent: 0,
            conflicts: Vec::new(),
            unsynced_deletes: 0,
            skipped_oversize: 0,
        };

        if store.vault_id.trim().is_empty() {
            outcome.kind = SyncOutcomeKind::NotConfigured;
            return Ok(outcome);
        }
        let Some(key) = load_vault_key(&vault) else {
            outcome.kind = SyncOutcomeKind::NotConfigured;
            return Ok(outcome);
        };
        if store.peers.is_empty() {
            outcome.kind = SyncOutcomeKind::NoPeers;
            return Ok(outcome);
        }

        let identity = ensure_identity()?;
        endpoint::ensure_endpoint(*identity.seed(), app.clone())
            .await
            .map_err(CommandError::from)?;

        let now = now_ms();
        let peers = store.peers.clone();
        let vault_id = store.vault_id.clone();
        let (any_reached, any_transfer) = sync_peers(
            &dir,
            &vault,
            &vault_id,
            &key,
            &peers,
            now,
            &mut store,
            &mut outcome,
            |peer, ctx| async move { endpoint::dial_and_sync(&peer, &ctx).await },
        )
        .await?;

        store
            .save(&dir)
            .map_err(|e| CommandError::internal(e.to_string()))?;

        outcome.conflicts.sort();
        outcome.conflicts.dedup();
        outcome.kind = if !any_reached {
            SyncOutcomeKind::PeerUnreachable
        } else if any_transfer {
            SyncOutcomeKind::Synced
        } else {
            SyncOutcomeKind::UpToDate
        };
        Ok(outcome)
    }

    /// Reconcile a joining ticket's vault id against the local store's: adopt it
    /// when the local store has none yet, accept it when it already matches, and
    /// reject it when it names a *different* sync identity (the vault is already
    /// paired elsewhere). Extracted from [`join`] so the pairing guard is
    /// unit-testable without a live endpoint or keychain.
    fn reconcile_vault_id(existing: &str, incoming: &str) -> Result<String, CommandError> {
        if existing.trim().is_empty() {
            Ok(incoming.to_string())
        } else if existing == incoming {
            Ok(existing.to_string())
        } else {
            Err(CommandError::internal(
                "sync: this vault is already paired to a different sync identity",
            ))
        }
    }

    /// The per-peer sync loop, factored out of [`sync_now`] so its outcome
    /// aggregation and per-peer base-manifest persistence can be unit-tested with
    /// a fake `dial` (no real QUIC). Given the resolved vault context, it walks
    /// the peers, loads each peer's base manifest, runs one sync via `dial`, and —
    /// for every peer reached — persists the returned base, marks the sync time,
    /// and folds the per-peer counts into `outcome`. Unreachable peers are logged
    /// and skipped. Returns `(any_reached, any_transfer)` for the caller's outcome
    /// classification. Transport-agnostic: `dial` owns its `PeerRecord` +
    /// `SessionCtx` so it can move them into a spawned future.
    #[allow(clippy::too_many_arguments)]
    async fn sync_peers<F, Fut>(
        dir: &Path,
        vault: &Path,
        vault_id: &str,
        key: &VaultKey,
        peers: &[PeerRecord],
        now: i64,
        store: &mut SyncStore,
        outcome: &mut SyncOutcome,
        mut dial: F,
    ) -> Result<(bool, bool), CommandError>
    where
        F: FnMut(PeerRecord, SessionCtx) -> Fut,
        Fut: std::future::Future<Output = CoreResult<SessionOutcome>>,
    {
        let mut any_reached = false;
        let mut any_transfer = false;
        for peer in peers {
            let base = store::load_base_manifest(dir, &peer.node_id);
            let ctx = SessionCtx {
                vault: vault.to_path_buf(),
                vault_id: vault_id.to_string(),
                key: key.clone(),
                base,
            };
            match dial(peer.clone(), ctx).await {
                Ok(out) => {
                    any_reached = true;
                    if out.taken > 0 || out.sent > 0 || !out.conflicts.is_empty() {
                        any_transfer = true;
                    }
                    store::save_base_manifest(dir, &peer.node_id, &out.new_base)
                        .map_err(|e| CommandError::internal(e.to_string()))?;
                    store.mark_synced(&peer.node_id, now);
                    outcome.taken += out.taken;
                    outcome.sent += out.sent;
                    outcome.unsynced_deletes += out.unsynced_deletes;
                    outcome.skipped_oversize += out.skipped_oversize;
                    outcome.conflicts.extend(out.conflicts);
                }
                Err(e) => log::warn!("sync: peer {} unreachable this cycle: {e}", peer.node_id),
            }
        }
        Ok((any_reached, any_transfer))
    }

    /// The responder context for the accept loop: resolve the currently-open
    /// vault's id + E2E key. Errors (no vault / not configured) refuse the
    /// inbound sync cleanly.
    pub(crate) fn responder_ctx(app: &AppHandle) -> CoreResult<SessionCtx> {
        let (vault, data) =
            vault_and_data(app).map_err(|e| CoreError::Internal(format!("sync: {}", e.message)))?;
        let dir = sync_dir(&data);
        let store = SyncStore::load(&dir);
        if store.vault_id.trim().is_empty() {
            return Err(CoreError::BadRequest(
                "sync: this vault is not configured for P2P sync".to_string(),
            ));
        }
        let key = load_vault_key(&vault)
            .ok_or_else(|| CoreError::BadRequest("sync: no E2E key for this vault".to_string()))?;
        Ok(SessionCtx {
            vault,
            vault_id: store.vault_id,
            key,
            // The responder does not plan, so its base is irrelevant.
            base: Manifest::default(),
        })
    }

    /// Whether an inbound node id is already a paired peer — decides if the
    /// responder demands the vault-key challenge before serving its manifest.
    pub(crate) fn is_known_peer(app: &AppHandle, node_hex: &str) -> CoreResult<bool> {
        let (_vault, data) =
            vault_and_data(app).map_err(|e| CoreError::Internal(format!("sync: {}", e.message)))?;
        let store = SyncStore::load(&sync_dir(&data));
        Ok(store.peers.iter().any(|p| p.node_id == node_hex))
    }

    /// Persist a peer that just proved vault-key possession over the wire —
    /// the responder-side half of pairing (`join` only records the ticket
    /// generator on the joiner). Future syncs skip the challenge and this
    /// device can dial the peer back.
    pub(crate) fn register_peer(app: &AppHandle, node_hex: &str) -> CoreResult<()> {
        let (_vault, data) =
            vault_and_data(app).map_err(|e| CoreError::Internal(format!("sync: {}", e.message)))?;
        let dir = sync_dir(&data);
        let mut store = SyncStore::load(&dir);
        store.upsert_peer(PeerRecord {
            node_id: node_hex.to_string(),
            label: node_hex.chars().take(8).collect(),
            relay: None,
            // No address hints: iroh's node-id discovery resolves the dial.
            addrs: Vec::new(),
            last_synced_ms: None,
        });
        store.save(&dir)
    }

    #[cfg(test)]
    mod tests {
        use novalis_core::sync::manifest::FileEntry;

        use super::*;

        fn peer(node: &str) -> PeerRecord {
            PeerRecord {
                node_id: node.to_string(),
                label: node.chars().take(8).collect(),
                relay: None,
                addrs: Vec::new(),
                last_synced_ms: None,
            }
        }

        fn manifest_with(path: &str, hash: &str) -> Manifest {
            let mut m = Manifest::default();
            m.entries.insert(
                path.to_string(),
                FileEntry {
                    path: path.to_string(),
                    hash: hash.to_string(),
                    size: 1,
                    mtime_ms: 0,
                },
            );
            m
        }

        fn ok_outcome(taken: u32, sent: u32, new_base: Manifest) -> SessionOutcome {
            SessionOutcome {
                taken,
                sent,
                conflicts: Vec::new(),
                unsynced_deletes: 0,
                skipped_oversize: 0,
                peer_authenticated: false,
                new_base,
            }
        }

        fn empty_outcome() -> SyncOutcome {
            SyncOutcome {
                kind: SyncOutcomeKind::UpToDate,
                taken: 0,
                sent: 0,
                conflicts: Vec::new(),
                unsynced_deletes: 0,
                skipped_oversize: 0,
            }
        }

        #[test]
        fn reconcile_vault_id_adopts_when_unset() {
            assert_eq!(reconcile_vault_id("", "vault-x").unwrap(), "vault-x");
            assert_eq!(reconcile_vault_id("   ", "vault-x").unwrap(), "vault-x");
        }

        #[test]
        fn reconcile_vault_id_accepts_matching() {
            assert_eq!(reconcile_vault_id("vault-x", "vault-x").unwrap(), "vault-x");
        }

        #[test]
        fn reconcile_vault_id_rejects_mismatch() {
            let err = reconcile_vault_id("vault-x", "vault-y").unwrap_err();
            assert!(
                err.message.contains("already paired"),
                "mismatch must be rejected, got: {}",
                err.message
            );
        }

        // Some peers reachable, one not: outcomes fold in, unreachable peers are
        // skipped (no timestamp), and the reached/transfer flags classify right.
        #[tokio::test]
        async fn sync_peers_aggregates_reachable_and_skips_unreachable() {
            let dir = tempfile::tempdir().unwrap();
            let vault = dir.path().join("vault");
            let key = VaultKey::generate();
            let peers = vec![peer("aa"), peer("bb"), peer("cc")];
            let mut store = SyncStore::default();
            for p in &peers {
                store.upsert_peer(p.clone());
            }
            let mut outcome = empty_outcome();

            // aa moves files, bb is unreachable, cc is reached but up-to-date.
            let (any_reached, any_transfer) = sync_peers(
                dir.path(),
                &vault,
                "vault-x",
                &key,
                &peers,
                42,
                &mut store,
                &mut outcome,
                |peer, _ctx| async move {
                    match peer.node_id.as_str() {
                        "aa" => Ok(ok_outcome(2, 1, manifest_with("aa.md", "h-aa"))),
                        "bb" => Err(CoreError::Internal("unreachable".to_string())),
                        _ => Ok(ok_outcome(0, 0, manifest_with("cc.md", "h-cc"))),
                    }
                },
            )
            .await
            .unwrap();

            assert!(any_reached, "aa and cc were reached");
            assert!(any_transfer, "aa moved files, so a transfer happened");
            assert_eq!(outcome.taken, 2);
            assert_eq!(outcome.sent, 1);

            let ts = |n: &str| {
                store
                    .peers
                    .iter()
                    .find(|p| p.node_id == n)
                    .unwrap()
                    .last_synced_ms
            };
            assert_eq!(ts("aa"), Some(42), "reached peer marked synced");
            assert_eq!(ts("bb"), None, "unreachable peer keeps no timestamp");
            assert_eq!(ts("cc"), Some(42), "reached-but-up-to-date still marked");
        }

        // Every reached peer's returned base manifest is persisted under its own
        // node id, so the next cycle plans from the right base per peer.
        #[tokio::test]
        async fn sync_peers_persists_base_manifest_per_peer() {
            let dir = tempfile::tempdir().unwrap();
            let vault = dir.path().join("vault");
            let key = VaultKey::generate();
            let peers = vec![peer("aa"), peer("bb")];
            let mut store = SyncStore::default();
            for p in &peers {
                store.upsert_peer(p.clone());
            }
            let mut outcome = empty_outcome();

            let base_aa = manifest_with("aa.md", "hash-aa");
            let base_bb = manifest_with("bb.md", "hash-bb");
            let ret_aa = base_aa.clone();
            let ret_bb = base_bb.clone();

            sync_peers(
                dir.path(),
                &vault,
                "vault-x",
                &key,
                &peers,
                7,
                &mut store,
                &mut outcome,
                move |peer, ctx| {
                    // First sync for each peer: base starts empty.
                    assert_eq!(ctx.base, Manifest::default(), "first cycle base is empty");
                    let next = if peer.node_id == "aa" {
                        ret_aa.clone()
                    } else {
                        ret_bb.clone()
                    };
                    async move { Ok(ok_outcome(0, 1, next)) }
                },
            )
            .await
            .unwrap();

            assert_eq!(store::load_base_manifest(dir.path(), "aa"), base_aa);
            assert_eq!(store::load_base_manifest(dir.path(), "bb"), base_bb);
        }
    }
}

#[cfg(not(desktop))]
mod imp {
    use novalis_core::models::{SyncOutcome, SyncOutcomeKind, SyncStatus};
    use tauri::AppHandle;

    use crate::engine::CommandError;

    fn unsupported() -> CommandError {
        CommandError::internal("P2P sync is only available on the desktop build")
    }

    pub(crate) fn status(_app: &AppHandle) -> Result<SyncStatus, CommandError> {
        Ok(SyncStatus {
            configured: false,
            node_id: None,
            vault_id: None,
            peer_count: 0,
            listening: false,
            peers: Vec::new(),
        })
    }

    pub(crate) async fn generate_ticket(_app: &AppHandle) -> Result<String, CommandError> {
        Err(unsupported())
    }

    pub(crate) async fn join(_app: &AppHandle, _ticket: String) -> Result<(), CommandError> {
        Err(unsupported())
    }

    pub(crate) async fn sync_now(_app: &AppHandle) -> Result<SyncOutcome, CommandError> {
        let _ = SyncOutcomeKind::NotConfigured;
        Err(unsupported())
    }
}
