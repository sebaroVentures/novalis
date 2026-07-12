//! The `iroh` QUIC transport for P2P sync (desktop only, mirroring the
//! `fastembed`/`keyring` desktop split).
//!
//! `iroh` gives us: a process endpoint keyed by the device's ed25519 secret
//! (its public half is the dialable **node id**); NAT traversal / holepunching
//! coordinated through n0's public relay mesh (which carries only QUIC-encrypted,
//! already-E2E-sealed bytes — never vault plaintext, and stores nothing, so the
//! "no central server for your data" property holds); and authenticated
//! bidirectional streams whose `SendStream`/`RecvStream` implement tokio's
//! `AsyncWrite`/`AsyncRead` — exactly what [`super::session`] drives.
//!
//! This module is the thin async glue: stand up the endpoint, run an accept
//! loop that serves the open vault (responder role), and dial a paired peer to
//! run one sync (initiator role). All protocol/crypto logic lives elsewhere.

use std::net::SocketAddr;

use iroh::endpoint::{presets, Connection};
use iroh::{Endpoint, EndpointAddr, PublicKey, SecretKey};
use novalis_core::sync::store::PeerRecord;
use novalis_core::{CoreError, CoreResult};
use tauri::AppHandle;
use tokio::sync::OnceCell;

use super::session::{self, SessionCtx, SessionOutcome};

/// Application-layer protocol negotiated on every connection.
pub const ALPN: &[u8] = b"novalis/sync/1";

/// The one endpoint per process. Created lazily on the first sync operation and
/// reused (its node id must stay stable for the lifetime of the app).
static ENDPOINT: OnceCell<Endpoint> = OnceCell::const_new();

/// Get-or-create the process endpoint from the 32-byte device seed, starting
/// the accept loop that serves the currently-open vault. Idempotent.
pub async fn ensure_endpoint(seed: [u8; 32], app: AppHandle) -> CoreResult<&'static Endpoint> {
    ENDPOINT
        .get_or_try_init(|| async move {
            let secret = SecretKey::from_bytes(&seed);
            let endpoint = Endpoint::builder(presets::N0)
                .secret_key(secret)
                .alpns(vec![ALPN.to_vec()])
                .bind()
                .await
                .map_err(|e| CoreError::Internal(format!("sync: endpoint bind failed: {e}")))?;
            // Serve incoming syncs for the lifetime of the process.
            let serving = endpoint.clone();
            tauri::async_runtime::spawn(accept_loop(serving, app));
            Ok::<_, CoreError>(endpoint)
        })
        .await
}

/// Whether the endpoint is up (used for the status readout).
pub fn is_listening() -> bool {
    ENDPOINT.get().is_some()
}

/// This device's node id (hex), once the endpoint exists.
pub fn local_node_id_hex() -> Option<String> {
    ENDPOINT.get().map(|ep| hex(ep.id().as_bytes()))
}

/// The best-known reachability for this endpoint, for baking into a pairing
/// ticket: node id + any bound direct socket addresses. Relay coordinates are
/// resolved by the dialer via node-id discovery (presets::N0), so a ticket with
/// just the node id still connects over WAN; direct addrs speed up LAN/same-host.
pub fn local_reachability() -> Option<(String, Vec<String>)> {
    let ep = ENDPOINT.get()?;
    let node = hex(ep.id().as_bytes());
    let addrs = ep
        .bound_sockets()
        .into_iter()
        .filter(|s| !s.ip().is_unspecified())
        .map(|s| s.to_string())
        .collect();
    Some((node, addrs))
}

/// Dial a paired peer and run one sync as the initiator. The connection is
/// authenticated by the peer's node id; every file byte on it is E2E-sealed.
pub async fn dial_and_sync(peer: &PeerRecord, ctx: &SessionCtx) -> CoreResult<SessionOutcome> {
    let endpoint = ENDPOINT
        .get()
        .ok_or_else(|| CoreError::Internal("sync: endpoint not started".to_string()))?;
    let addr = peer_addr(peer)?;
    let conn = endpoint
        .connect(addr, ALPN)
        .await
        .map_err(|e| CoreError::Internal(format!("sync: connect to peer failed: {e}")))?;
    let (mut send, mut recv) = conn
        .open_bi()
        .await
        .map_err(|e| CoreError::Internal(format!("sync: open stream failed: {e}")))?;
    let outcome = session::run_initiator(&mut recv, &mut send, ctx).await?;
    // Everything (incl. Done) is sent; half-close our send stream and wait for
    // the responder to finish applying and close the connection. Closing
    // abruptly here would abort the responder's in-flight work mid-write.
    let _ = send.finish();
    conn.closed().await;
    Ok(outcome)
}

/// Accept loop: for every inbound connection, serve one sync against the open
/// vault. Each connection is handled on its own task so a slow peer can't block
/// others.
async fn accept_loop(endpoint: Endpoint, app: AppHandle) {
    while let Some(incoming) = endpoint.accept().await {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = serve_one(incoming, &app).await {
                log::warn!("sync: serving a peer failed: {e}");
            }
        });
    }
    log::info!("sync: accept loop ended (endpoint closed)");
}

async fn serve_one(incoming: iroh::endpoint::Incoming, app: &AppHandle) -> CoreResult<()> {
    let conn: Connection = incoming
        .await
        .map_err(|e| CoreError::Internal(format!("sync: accept connection failed: {e}")))?;
    let (mut send, mut recv) = conn
        .accept_bi()
        .await
        .map_err(|e| CoreError::Internal(format!("sync: accept stream failed: {e}")))?;

    // Resolve the responder context for whatever vault is currently open. If no
    // vault is open, or sync isn't set up for it, refuse cleanly.
    let ctx = super::service::responder_ctx(app)?;
    let out = session::run_responder(&mut recv, &mut send, &ctx).await?;
    log::info!(
        "sync: served peer (received {}, sent {})",
        out.taken,
        out.sent
    );
    // We've applied everything; gracefully close so the initiator's `closed()`
    // returns promptly instead of waiting for the idle timeout.
    let _ = send.finish();
    conn.close(0u8.into(), b"ok");
    Ok(())
}

/// Build an `EndpointAddr` to dial from a stored peer record.
fn peer_addr(peer: &PeerRecord) -> CoreResult<EndpointAddr> {
    let bytes: [u8; 32] = decode_hex(&peer.node_id)?
        .try_into()
        .map_err(|_| CoreError::BadRequest("sync: peer node id must be 32 bytes".to_string()))?;
    let key = PublicKey::from_bytes(&bytes)
        .map_err(|e| CoreError::BadRequest(format!("sync: invalid peer node id: {e}")))?;
    let mut addr = EndpointAddr::new(key);
    for a in &peer.addrs {
        if let Ok(sa) = a.parse::<SocketAddr>() {
            addr = addr.with_ip_addr(sa);
        }
    }
    Ok(addr)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex(hex: &str) -> CoreResult<Vec<u8>> {
    let hex = hex.trim();
    if !hex.len().is_multiple_of(2) {
        return Err(CoreError::BadRequest(
            "sync: hex has odd length".to_string(),
        ));
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&hex[i..i + 2], 16)
                .map_err(|_| CoreError::BadRequest("sync: invalid hex".to_string()))
        })
        .collect()
}

// A true two-endpoint loopback sync over real QUIC lives behind a feature so
// its (network-touching, relay-disabled) setup never gates fmt/clippy/test. Run
// it with:
//   cargo test -p novalis-desktop --features p2p-loopback-test p2p_loopback -- --nocapture
#[cfg(all(test, feature = "p2p-loopback-test"))]
mod loopback_test {
    use std::path::PathBuf;

    use iroh::endpoint::{presets, RelayMode};
    use iroh::{Endpoint, EndpointAddr, SecretKey};
    use novalis_core::sync::{Manifest, VaultKey};

    use super::*;

    fn vault_with(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        for (p, c) in files {
            std::fs::write(vault.join(p), c).unwrap();
        }
        (tmp, vault)
    }

    async fn loopback_endpoint(seed: [u8; 32]) -> Endpoint {
        Endpoint::builder(presets::N0)
            .secret_key(SecretKey::from_bytes(&seed))
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(RelayMode::Disabled)
            .bind_addr("127.0.0.1:0".parse::<std::net::SocketAddr>().unwrap())
            .unwrap()
            .bind()
            .await
            .unwrap()
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn p2p_loopback_syncs_an_encrypted_file() {
        let key = VaultKey::generate();
        let (_ta, va) = vault_with(&[("a.md", "alpha over quic")]);
        let (_tb, vb) = vault_with(&[]);

        let server = loopback_endpoint([1u8; 32]).await;
        let client = loopback_endpoint([2u8; 32]).await;

        // Server accepts and responds.
        let server_ctx = SessionCtx {
            vault: vb.clone(),
            vault_id: "vault-x".to_string(),
            key: key.clone(),
            base: Manifest::default(),
        };
        let srv = server.clone();
        let server_task = tokio::spawn(async move {
            let incoming = srv.accept().await.expect("incoming");
            let conn = incoming.await.expect("conn");
            let (mut send, mut recv) = conn.accept_bi().await.expect("accept_bi");
            session::run_responder(&mut recv, &mut send, &server_ctx)
                .await
                .expect("responder");
            let _ = send.finish();
            conn.close(0u8.into(), b"ok");
        });

        // Client dials the server's bound loopback address directly.
        let port = server.bound_sockets()[0].port();
        let addr = EndpointAddr::new(server.id())
            .with_ip_addr(format!("127.0.0.1:{port}").parse().unwrap());
        let conn = client.connect(addr, ALPN).await.expect("connect");
        let (mut send, mut recv) = conn.open_bi().await.expect("open_bi");
        let client_ctx = SessionCtx {
            vault: va.clone(),
            vault_id: "vault-x".to_string(),
            key,
            base: Manifest::default(),
        };
        let out = session::run_initiator(&mut recv, &mut send, &client_ctx)
            .await
            .expect("initiator");
        let _ = send.finish();
        conn.closed().await;
        server_task.await.unwrap();

        assert_eq!(out.sent, 1);
        // The file crossed the wire E2E-encrypted and decrypted on the server.
        assert_eq!(
            std::fs::read_to_string(vb.join("a.md")).unwrap(),
            "alpha over quic"
        );
    }
}
