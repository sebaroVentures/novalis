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

#[cfg(desktop)]
pub(crate) use imp::responder_ctx;
pub(crate) use imp::{generate_ticket, join, status, sync_now};

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
    use crate::sync::session::SessionCtx;

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
        if store.vault_id.trim().is_empty() {
            store.vault_id = ticket.vault_id.clone();
        } else if store.vault_id != ticket.vault_id {
            return Err(CommandError::internal(
                "sync: this vault is already paired to a different sync identity",
            ));
        }

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
        let mut any_reached = false;
        let mut any_transfer = false;

        for peer in &peers {
            let base = store::load_base_manifest(&dir, &peer.node_id);
            let ctx = SessionCtx {
                vault: vault.clone(),
                vault_id: store.vault_id.clone(),
                key: key.clone(),
                base,
            };
            match endpoint::dial_and_sync(peer, &ctx).await {
                Ok(out) => {
                    any_reached = true;
                    if out.taken > 0 || out.sent > 0 || !out.conflicts.is_empty() {
                        any_transfer = true;
                    }
                    store::save_base_manifest(&dir, &peer.node_id, &out.new_base)
                        .map_err(|e| CommandError::internal(e.to_string()))?;
                    store.mark_synced(&peer.node_id, now);
                    outcome.taken += out.taken;
                    outcome.sent += out.sent;
                    outcome.unsynced_deletes += out.unsynced_deletes;
                    outcome.conflicts.extend(out.conflicts);
                }
                Err(e) => log::warn!("sync: peer {} unreachable this cycle: {e}", peer.node_id),
            }
        }

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
