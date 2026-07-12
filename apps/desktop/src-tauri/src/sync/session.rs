//! The sync **session driver**: the protocol loop that actually moves files
//! between two paired vaults, transport-agnostic over any tokio
//! `AsyncRead`/`AsyncWrite` pair.
//!
//! Keeping it generic (rather than hard-wiring `iroh` streams) is what makes it
//! testable: the [`tests`] module drives a full initiator↔responder sync over a
//! `tokio::io::duplex` pipe with **real** E2E encryption and asserts files land
//! decrypted on the far side — no sockets, fully deterministic. The `iroh`
//! transport ([`super::endpoint`]) simply hands its QUIC `SendStream` /
//! `RecvStream` (which implement these same traits) to the exact same code.
//!
//! ## Protocol (one cycle)
//! The **initiator** drives; the **responder** answers. After a `Hello`
//! handshake (protocol version + vault id must match) the responder sends its
//! [`Manifest`]. The initiator computes the 3-way [`plan`] against its stored
//! base and then, over the single ordered bi-stream:
//! - **Send**: pushes a `FileData` (responder overwrites) — no reply.
//! - **Take**: sends a `FileRequest`, reads the one `FileData`/`FileMissing`
//!   reply, writes it locally.
//! - **Conflict**: pulls the peer's version and writes it as a *conflict copy*
//!   ([`conflict_copy_path`]) — surfaced by the existing resolver, never
//!   overwriting the local original — and pushes its own version to the peer as
//!   a conflict copy too. Both sides keep both versions; the user reconciles.
//! - **DeletePending**: counted only (deletes are a deferred boundary).
//!
//! Requests and their replies are 1:1 and in stream order, so the loop needs no
//! concurrent read/write. Frames are length-prefixed; file bytes travel
//! **sealed** (see [`crate`]'s core `sync::crypto`).

use std::path::{Path, PathBuf};

use novalis_core::sync::manifest::{self, FileAction};
use novalis_core::sync::protocol::{Frame, PROTOCOL_VERSION};
use novalis_core::sync::{Manifest, VaultKey};
use novalis_core::vault::fs::vault_rel;
use novalis_core::{CoreError, CoreResult};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Hard cap on a single frame (length prefix is a `u32`). 64 MiB comfortably
/// covers notes and typical embedded media; larger files are skipped with a
/// logged warning rather than risking an unbounded allocation from a peer.
const MAX_FRAME: usize = 64 * 1024 * 1024;

/// Everything a session needs about the local vault. Owned (not borrowed) so it
/// can move into a spawned responder task.
pub struct SessionCtx {
    pub vault: PathBuf,
    pub vault_id: String,
    pub key: VaultKey,
    /// The last-synced base manifest for this peer (empty on first sync).
    pub base: Manifest,
}

/// What one session did, from the local side's perspective.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SessionOutcome {
    pub taken: u32,
    pub sent: u32,
    /// Vault-relative paths that diverged (a conflict copy was written).
    pub conflicts: Vec<String>,
    pub unsynced_deletes: u32,
    /// The base manifest to persist after this cycle (meaningful for the
    /// initiator, which owns the 3-way base; the responder returns its current
    /// manifest, which the caller ignores).
    pub new_base: Manifest,
}

/// Run the initiating (plan-driving) side of a sync.
pub async fn run_initiator<R, W>(
    reader: &mut R,
    writer: &mut W,
    ctx: &SessionCtx,
) -> CoreResult<SessionOutcome>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    write_frame(writer, &hello(ctx)).await?;
    expect_hello(read_frame(reader).await?, ctx)?;

    let remote = match read_frame(reader).await? {
        Frame::Manifest(m) => m,
        other => return Err(protocol_err("manifest", &other)),
    };
    let local = Manifest::build(&ctx.vault)?;
    let actions = manifest::plan(&ctx.base, &local, &remote);

    let mut out = SessionOutcome::default();
    for action in &actions {
        match action {
            FileAction::Send(path) => {
                if push_file(writer, ctx, path, path).await? {
                    out.sent += 1;
                }
            }
            FileAction::Take(path) => {
                if let Some(bytes) = request_file(reader, writer, ctx, path).await? {
                    write_vault_bytes(&ctx.vault, path, &bytes)?;
                    out.taken += 1;
                }
            }
            FileAction::Conflict(path) => {
                // Pull the peer's diverging version → write it beside ours as a
                // conflict copy the existing resolver will surface.
                if let Some(peer_bytes) = request_file(reader, writer, ctx, path).await? {
                    let copy = manifest::conflict_copy_path(path, &hash_tag(&peer_bytes));
                    write_if_absent(&ctx.vault, &copy, &peer_bytes)?;
                }
                // Push our version to the peer as a conflict copy on their side.
                if let Some(local_bytes) = read_vault_bytes(&ctx.vault, path)? {
                    let copy = manifest::conflict_copy_path(path, &hash_tag(&local_bytes));
                    push_bytes(writer, ctx, &copy, &local_bytes).await?;
                }
                out.conflicts.push(path.clone());
            }
            FileAction::DeletePending(_) => out.unsynced_deletes += 1,
        }
    }

    // `write_frame` already flushed each frame (incl. Done); no trailing flush.
    // The transport half-closes the send stream and waits for the peer.
    write_frame(writer, &Frame::Done).await?;
    out.new_base = manifest::next_base(&ctx.base, &local, &remote);
    Ok(out)
}

/// Run the responding (passive) side of a sync: answer file requests and apply
/// pushed files. Does not maintain a base (only the initiator plans); returns
/// its current manifest, which the caller ignores.
pub async fn run_responder<R, W>(
    reader: &mut R,
    writer: &mut W,
    ctx: &SessionCtx,
) -> CoreResult<SessionOutcome>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    expect_hello(read_frame(reader).await?, ctx)?;
    write_frame(writer, &hello(ctx)).await?;

    let local = Manifest::build(&ctx.vault)?;
    write_frame(writer, &Frame::Manifest(local.clone())).await?;

    let mut out = SessionOutcome::default();
    loop {
        match read_frame(reader).await? {
            Frame::FileRequest { path } => match read_vault_bytes(&ctx.vault, &path)? {
                Some(bytes) => {
                    let sealed = ctx.key.seal(&bytes)?;
                    write_frame(writer, &Frame::FileData { path, sealed }).await?;
                    out.sent += 1;
                }
                None => write_frame(writer, &Frame::FileMissing { path }).await?,
            },
            Frame::FileData { path, sealed } => {
                let bytes = ctx.key.open(&sealed)?;
                write_vault_bytes(&ctx.vault, &path, &bytes)?;
                out.taken += 1;
            }
            Frame::Done => break,
            other => return Err(protocol_err("request/data/done", &other)),
        }
    }
    // Each reply was already flushed by `write_frame`; nothing to flush here.
    out.new_base = local;
    Ok(out)
}

// ── Frame helpers (length-prefixed) ─────────────────────────────────────────

async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, frame: &Frame) -> CoreResult<()> {
    let bytes = frame.encode()?;
    let len = u32::try_from(bytes.len())
        .map_err(|_| CoreError::Internal("sync: frame exceeds 4 GiB".to_string()))?;
    w.write_all(&len.to_be_bytes()).await?;
    w.write_all(&bytes).await?;
    w.flush().await?;
    Ok(())
}

async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> CoreResult<Frame> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_FRAME {
        return Err(CoreError::BadRequest(format!(
            "sync: peer sent an oversized frame ({len} bytes)"
        )));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    Frame::decode(&buf)
}

fn hello(ctx: &SessionCtx) -> Frame {
    Frame::Hello {
        version: PROTOCOL_VERSION,
        vault_id: ctx.vault_id.clone(),
    }
}

fn expect_hello(frame: Frame, ctx: &SessionCtx) -> CoreResult<()> {
    match frame {
        Frame::Hello { version, vault_id } => {
            if version != PROTOCOL_VERSION {
                return Err(CoreError::BadRequest(format!(
                    "sync: protocol version mismatch (peer {version}, us {PROTOCOL_VERSION})"
                )));
            }
            if vault_id != ctx.vault_id {
                return Err(CoreError::BadRequest(
                    "sync: peer is paired to a different vault".to_string(),
                ));
            }
            Ok(())
        }
        other => Err(protocol_err("hello", &other)),
    }
}

fn protocol_err(expected: &str, got: &Frame) -> CoreError {
    CoreError::BadRequest(format!(
        "sync: expected {expected}, got {}",
        frame_name(got)
    ))
}

fn frame_name(f: &Frame) -> &'static str {
    match f {
        Frame::Hello { .. } => "hello",
        Frame::Manifest(_) => "manifest",
        Frame::FileRequest { .. } => "file-request",
        Frame::FileData { .. } => "file-data",
        Frame::FileMissing { .. } => "file-missing",
        Frame::Done => "done",
    }
}

// ── File transfer primitives ────────────────────────────────────────────────

/// Send the local file at `src` sealed, framed for the peer to write at `dest`.
/// Returns false (skipped) if the file vanished between planning and sending.
async fn push_file<W: AsyncWrite + Unpin>(
    w: &mut W,
    ctx: &SessionCtx,
    src: &str,
    dest: &str,
) -> CoreResult<bool> {
    match read_vault_bytes(&ctx.vault, src)? {
        Some(bytes) => {
            push_bytes(w, ctx, dest, &bytes).await?;
            Ok(true)
        }
        None => {
            log::warn!("sync: file to send vanished, skipping: {src}");
            Ok(false)
        }
    }
}

async fn push_bytes<W: AsyncWrite + Unpin>(
    w: &mut W,
    ctx: &SessionCtx,
    dest: &str,
    bytes: &[u8],
) -> CoreResult<()> {
    let sealed = ctx.key.seal(bytes)?;
    write_frame(
        w,
        &Frame::FileData {
            path: dest.to_string(),
            sealed,
        },
    )
    .await
}

/// Ask the peer for `path`; return its decrypted bytes, or `None` if the peer
/// reports it missing.
async fn request_file<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    reader: &mut R,
    writer: &mut W,
    ctx: &SessionCtx,
    path: &str,
) -> CoreResult<Option<Vec<u8>>> {
    write_frame(
        writer,
        &Frame::FileRequest {
            path: path.to_string(),
        },
    )
    .await?;
    match read_frame(reader).await? {
        Frame::FileData { sealed, .. } => Ok(Some(ctx.key.open(&sealed)?)),
        Frame::FileMissing { .. } => Ok(None),
        other => Err(protocol_err("file-data", &other)),
    }
}

// ── Vault byte IO (binary-safe atomic writes) ───────────────────────────────

fn read_vault_bytes(vault: &Path, rel: &str) -> CoreResult<Option<Vec<u8>>> {
    let abs = vault_rel(vault, rel)?;
    match std::fs::read(&abs) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(CoreError::Io(e)),
    }
}

/// Atomically write `bytes` to the vault-relative `rel` (same-dir temp, fsync,
/// then rename). Binary-safe (unlike `vault_fs::write_atomic`, which takes a
/// `&str`). Creates parent directories. We deliberately do NOT suppress the
/// file watcher: letting it reindex the written path — and reload open notes
/// via the external-change guard — mirrors exactly how a git pull's checkout is
/// adopted.
fn write_vault_bytes(vault: &Path, rel: &str, bytes: &[u8]) -> CoreResult<()> {
    use std::io::Write;
    let abs = vault_rel(vault, rel)?;
    let parent = abs
        .parent()
        .ok_or_else(|| CoreError::Internal(format!("sync: no parent for {rel}")))?;
    std::fs::create_dir_all(parent)?;
    let name = abs.file_name().unwrap_or_default().to_string_lossy();
    let tmp = parent.join(format!(".{name}.{}.sync-tmp", uuid::Uuid::new_v4()));
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, &abs)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(result?)
}

/// Like [`write_vault_bytes`] but a no-op if the destination already exists with
/// identical content — the dedup that keeps re-syncing an unresolved conflict
/// from spamming copies (the conflict-copy name is content-addressed).
fn write_if_absent(vault: &Path, rel: &str, bytes: &[u8]) -> CoreResult<()> {
    if let Some(existing) = read_vault_bytes(vault, rel)? {
        if existing == bytes {
            return Ok(());
        }
    }
    write_vault_bytes(vault, rel, bytes)
}

/// First 8 hex chars of the SHA-256 of `bytes` — the content-addressed tag in a
/// conflict-copy filename.
fn hash_tag(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize()).chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn vault_with(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        for (p, c) in files {
            let abs = vault.join(p);
            std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
            std::fs::write(abs, c).unwrap();
        }
        (tmp, vault)
    }

    fn ctx(vault: PathBuf, key: &VaultKey, base: Manifest) -> SessionCtx {
        SessionCtx {
            vault,
            vault_id: "vault-under-test".to_string(),
            key: key.clone(),
            base,
        }
    }

    fn read(vault: &Path, rel: &str) -> String {
        std::fs::read_to_string(vault.join(rel)).unwrap()
    }

    /// Drive a full initiator↔responder cycle over an in-memory duplex pipe and
    /// return both outcomes. Real XChaCha20-Poly1305 sealing runs end-to-end.
    async fn sync_pair(init: SessionCtx, resp: SessionCtx) -> (SessionOutcome, SessionOutcome) {
        let (a, b) = tokio::io::duplex(1024 * 1024);
        let (mut ar, mut aw) = tokio::io::split(a);
        let (mut br, mut bw) = tokio::io::split(b);

        let responder =
            tokio::spawn(async move { run_responder(&mut br, &mut bw, &resp).await.unwrap() });
        let init_out = run_initiator(&mut ar, &mut aw, &init).await.unwrap();
        let resp_out = responder.await.unwrap();
        (init_out, resp_out)
    }

    #[tokio::test]
    async fn transfers_a_new_file_both_directions() {
        let key = VaultKey::generate();
        // A has a.md; B has b.md. After a sync each vault should hold both.
        let (_ta, va) = vault_with(&[("a.md", "alpha")]);
        let (_tb, vb) = vault_with(&[("b.md", "bravo")]);

        let (ia, ib) = sync_pair(
            ctx(va.clone(), &key, Manifest::default()),
            ctx(vb.clone(), &key, Manifest::default()),
        )
        .await;

        // Initiator (A) sent a.md and took b.md.
        assert_eq!(ia.sent, 1);
        assert_eq!(ia.taken, 1);
        assert!(ia.conflicts.is_empty());
        // A received b.md (decrypted correctly).
        assert_eq!(read(&va, "b.md"), "bravo");
        // B received a.md (responder applied the pushed, sealed file).
        assert_eq!(read(&vb, "a.md"), "alpha");
        assert_eq!(ib.taken, 1); // b applied a.md
        assert_eq!(ib.sent, 1); // b served b.md
    }

    #[tokio::test]
    async fn divergent_edits_surface_as_conflict_copies_never_overwrite() {
        let key = VaultKey::generate();
        // Both started from "base" (recorded in the base manifest) then edited
        // the same file differently — a true conflict.
        let base_manifest = {
            let (_t, v) = vault_with(&[("Note.md", "base")]);
            Manifest::build(&v).unwrap()
        };
        let (_ta, va) = vault_with(&[("Note.md", "mine")]);
        let (_tb, vb) = vault_with(&[("Note.md", "theirs")]);

        let (ia, _ib) = sync_pair(
            ctx(va.clone(), &key, base_manifest.clone()),
            ctx(vb.clone(), &key, base_manifest),
        )
        .await;

        assert_eq!(ia.conflicts, vec!["Note.md".to_string()]);
        // Neither original was overwritten.
        assert_eq!(read(&va, "Note.md"), "mine");
        assert_eq!(read(&vb, "Note.md"), "theirs");
        // A gained a conflict copy holding B's version, and vice-versa.
        let a_has_theirs = novalis_core::conflict::list_conflicts(&va)
            .iter()
            .any(|c| c.original_path == "Note.md");
        let b_has_mine = novalis_core::conflict::list_conflicts(&vb)
            .iter()
            .any(|c| c.original_path == "Note.md");
        assert!(
            a_has_theirs,
            "A must surface a conflict copy of B's version"
        );
        assert!(b_has_mine, "B must surface a conflict copy of A's version");
    }

    #[tokio::test]
    async fn clean_sync_is_a_noop_second_time() {
        let key = VaultKey::generate();
        let (_ta, va) = vault_with(&[("a.md", "alpha")]);
        let (_tb, vb) = vault_with(&[]);

        let (first, _) = sync_pair(
            ctx(va.clone(), &key, Manifest::default()),
            ctx(vb.clone(), &key, Manifest::default()),
        )
        .await;
        assert_eq!(first.sent, 1);

        // Second sync using the base the first produced: nothing to do.
        let (second, _) = sync_pair(
            ctx(va.clone(), &key, first.new_base),
            ctx(vb.clone(), &key, Manifest::default()),
        )
        .await;
        assert_eq!(second.sent, 0);
        assert_eq!(second.taken, 0);
        assert!(second.conflicts.is_empty());
    }

    #[tokio::test]
    async fn mismatched_vault_id_is_refused() {
        let key = VaultKey::generate();
        let (_ta, va) = vault_with(&[("a.md", "x")]);
        let (_tb, vb) = vault_with(&[]);
        let mut init = ctx(va, &key, Manifest::default());
        init.vault_id = "vault-A".to_string();
        let mut resp = ctx(vb, &key, Manifest::default());
        resp.vault_id = "vault-B".to_string();

        let (a, b) = tokio::io::duplex(64 * 1024);
        let (mut ar, mut aw) = tokio::io::split(a);
        let (mut br, mut bw) = tokio::io::split(b);
        let responder = tokio::spawn(async move { run_responder(&mut br, &mut bw, &resp).await });
        let init_res = run_initiator(&mut ar, &mut aw, &init).await;
        let resp_res = responder.await.unwrap();
        assert!(init_res.is_err(), "initiator must reject a different vault");
        assert!(resp_res.is_err(), "responder must reject a different vault");
    }
}
