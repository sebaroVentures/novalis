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
//! handshake (protocol version + vault id must match), a responder that does
//! not recognize the peer's node id first demands proof of vault-key
//! possession (`Challenge`/`ChallengeResponse` — the vault id is not a
//! secret, the key is). Only then does the responder send its [`Manifest`].
//! The initiator computes the 3-way [`plan`] against its stored base and
//! then, over the single ordered bi-stream:
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

use novalis_core::sync::crypto::challenge_nonce;
use novalis_core::sync::manifest::{self, FileAction};
use novalis_core::sync::protocol::{Frame, PROTOCOL_VERSION};
use novalis_core::sync::{Manifest, VaultKey};
use novalis_core::vault::fs::vault_rel;
use novalis_core::{CoreError, CoreResult};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Hard cap on a single frame (length prefix is a `u32`). 64 MiB comfortably
/// covers notes and typical embedded media; larger files are skipped with a
/// logged warning (and counted in [`SessionOutcome::skipped_oversize`]) rather
/// than risking an unbounded allocation from a peer.
const MAX_FRAME: usize = 64 * 1024 * 1024;

/// The largest file the session will transfer: [`MAX_FRAME`] minus headroom
/// for the sealing overhead (24-byte nonce + 16-byte tag) and the frame
/// encoding (path + varints). Enforced where the plan executes so an
/// oversized file is skipped up front, never sent as a frame the peer's
/// [`read_frame`] would fatally reject mid-protocol.
const MAX_FILE: u64 = (MAX_FRAME - 64 * 1024) as u64;

/// Everything a session needs about the local vault. Owned (not borrowed) so it
/// can move into a spawned responder task.
pub struct SessionCtx {
    pub vault: PathBuf,
    pub vault_id: String,
    pub key: VaultKey,
    /// The last-synced base manifest for this peer (empty on first sync).
    pub base: Manifest,
}

/// How much the transport already trusts the remote peer (responder side).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerTrust {
    /// The remote node id is already in the peer store — skip the challenge.
    Known,
    /// Never paired: must prove vault-key possession before anything (in
    /// particular the manifest) is revealed.
    Unknown,
}

/// What one session did, from the local side's perspective.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SessionOutcome {
    pub taken: u32,
    pub sent: u32,
    /// Vault-relative paths that diverged (a conflict copy was written).
    pub conflicts: Vec<String>,
    pub unsynced_deletes: u32,
    /// Files skipped because they exceed [`MAX_FILE`] — logged, never fatal.
    pub skipped_oversize: u32,
    /// Responder only: an [`PeerTrust::Unknown`] peer passed the vault-key
    /// challenge this session; the caller should persist the pairing.
    pub peer_authenticated: bool,
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

    // A responder that doesn't recognize our node id challenges us to prove we
    // hold the vault key before it reveals its manifest. Answer if asked.
    let remote = match read_frame(reader).await? {
        Frame::Challenge { nonce } => {
            let sealed = ctx.key.seal(&nonce)?;
            write_frame(writer, &Frame::ChallengeResponse { sealed }).await?;
            match read_frame(reader).await? {
                Frame::Manifest(m) => m,
                other => return Err(protocol_err("manifest", &other)),
            }
        }
        Frame::Manifest(m) => m,
        other => return Err(protocol_err("challenge/manifest", &other)),
    };
    let local = Manifest::build(&ctx.vault)?;
    let actions = manifest::plan(&ctx.base, &local, &remote);

    let mut out = SessionOutcome::default();
    // Paths whose action was skipped (oversize) or downgraded to a conflict
    // copy (raced by a local edit): their entry in the new base is reverted
    // below so the next cycle re-plans them instead of treating them as synced.
    let mut replan: Vec<String> = Vec::new();
    for action in &actions {
        match action {
            FileAction::Send(path) => {
                if oversize(&local, path) {
                    log::warn!("sync: skipping oversized file (> {MAX_FILE} bytes): {path}");
                    out.skipped_oversize += 1;
                    replan.push(path.clone());
                } else if push_file(writer, ctx, path, path).await? {
                    out.sent += 1;
                }
            }
            FileAction::Take(path) => {
                if oversize(&remote, path) {
                    log::warn!("sync: skipping oversized file (> {MAX_FILE} bytes): {path}");
                    out.skipped_oversize += 1;
                    replan.push(path.clone());
                } else if let Some(bytes) = request_file(reader, writer, ctx, path).await? {
                    let expected = local.entries.get(path).map(|e| e.hash.as_str());
                    match apply_incoming(&ctx.vault, path, &bytes, expected)? {
                        Applied::Written => out.taken += 1,
                        Applied::ConflictCopy => {
                            out.conflicts.push(path.clone());
                            replan.push(path.clone());
                        }
                    }
                }
            }
            FileAction::Conflict(path) => {
                if oversize(&local, path) || oversize(&remote, path) {
                    // No base fixup needed: next_base omits conflicts anyway,
                    // so the conflict re-surfaces next cycle regardless.
                    log::warn!("sync: skipping oversized file (> {MAX_FILE} bytes): {path}");
                    out.skipped_oversize += 1;
                    continue;
                }
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
    // Revert skipped/diverted paths to their old base entry: recording the
    // transfer `next_base` assumed would flip the next plan's verdict (e.g. a
    // skipped Take would come back as a Send of our stale copy).
    for path in &replan {
        match ctx.base.entries.get(path) {
            Some(e) => {
                out.new_base.entries.insert(path.clone(), e.clone());
            }
            None => {
                out.new_base.entries.remove(path);
            }
        }
    }
    Ok(out)
}

/// Run the responding (passive) side of a sync: answer file requests and apply
/// pushed files. Does not maintain a base (only the initiator plans); returns
/// its current manifest, which the caller ignores.
pub async fn run_responder<R, W>(
    reader: &mut R,
    writer: &mut W,
    ctx: &SessionCtx,
    trust: PeerTrust,
) -> CoreResult<SessionOutcome>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    expect_hello(read_frame(reader).await?, ctx)?;
    write_frame(writer, &hello(ctx)).await?;

    let mut out = SessionOutcome::default();
    // The transport authenticates *who* the peer is (its node id); an unknown
    // node id must additionally prove it is *authorized* — that it holds the
    // vault key — before we reveal anything (the manifest lists every path,
    // size and hash; the vault id in Hello is deliberately not a secret).
    if trust == PeerTrust::Unknown {
        let nonce = challenge_nonce();
        write_frame(
            writer,
            &Frame::Challenge {
                nonce: nonce.to_vec(),
            },
        )
        .await?;
        let failed =
            || CoreError::BadRequest("sync: peer failed the vault-key challenge".to_string());
        match read_frame(reader).await? {
            Frame::ChallengeResponse { sealed } => {
                let proof = ctx.key.open(&sealed).map_err(|_| failed())?;
                if proof != nonce {
                    return Err(failed());
                }
            }
            other => return Err(protocol_err("challenge-response", &other)),
        }
        out.peer_authenticated = true;
    }

    let local = Manifest::build(&ctx.vault)?;
    write_frame(writer, &Frame::Manifest(local.clone())).await?;

    loop {
        match read_frame(reader).await? {
            Frame::FileRequest { path } => match read_vault_bytes(&ctx.vault, &path)? {
                Some(bytes) if bytes.len() as u64 > MAX_FILE => {
                    // Grew past the cap since our manifest was built (or the
                    // peer's view is stale): refuse gracefully instead of
                    // sending a frame the peer would fatally reject.
                    log::warn!(
                        "sync: refusing oversized file request (> {MAX_FILE} bytes): {path}"
                    );
                    out.skipped_oversize += 1;
                    write_frame(writer, &Frame::FileMissing { path }).await?;
                }
                Some(bytes) => {
                    let sealed = ctx.key.seal(&bytes)?;
                    write_frame(writer, &Frame::FileData { path, sealed }).await?;
                    out.sent += 1;
                }
                None => write_frame(writer, &Frame::FileMissing { path }).await?,
            },
            Frame::FileData { path, sealed } => {
                let bytes = ctx.key.open(&sealed)?;
                let expected = local.entries.get(&path).map(|e| e.hash.as_str());
                match apply_incoming(&ctx.vault, &path, &bytes, expected)? {
                    Applied::Written => out.taken += 1,
                    Applied::ConflictCopy => out.conflicts.push(path),
                }
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
        Frame::Challenge { .. } => "challenge",
        Frame::ChallengeResponse { .. } => "challenge-response",
        Frame::Manifest(_) => "manifest",
        Frame::FileRequest { .. } => "file-request",
        Frame::FileData { .. } => "file-data",
        Frame::FileMissing { .. } => "file-missing",
        Frame::Done => "done",
    }
}

/// Whether the manifest reports `path` as larger than the session will move.
fn oversize(m: &Manifest, path: &str) -> bool {
    m.entries.get(path).is_some_and(|e| e.size > MAX_FILE)
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
        // Safety net for a file that grew past the cap after planning: the
        // plan-level skip (which counts it) can't see the post-manifest size.
        Some(bytes) if bytes.len() as u64 > MAX_FILE => {
            log::warn!("sync: file to send grew oversized (> {MAX_FILE} bytes), skipping: {src}");
            Ok(false)
        }
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

/// Resolve a peer-supplied vault-relative path, refusing anything outside the
/// syncable surface (the same [`manifest::is_syncable_rel`] the manifest
/// walker uses) — otherwise a peer could read or write dot-paths the manifest
/// never advertises (`.novalis/plugins/…` would be code execution).
fn syncable_abs(vault: &Path, rel: &str) -> CoreResult<PathBuf> {
    if !manifest::is_syncable_rel(rel) {
        log::warn!("sync: refusing non-syncable path from peer: {rel}");
        return Err(CoreError::BadRequest(format!(
            "sync: non-syncable path: {rel}"
        )));
    }
    vault_rel(vault, rel)
}

fn read_vault_bytes(vault: &Path, rel: &str) -> CoreResult<Option<Vec<u8>>> {
    let abs = syncable_abs(vault, rel)?;
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
    let abs = syncable_abs(vault, rel)?;
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

/// What [`apply_incoming`] did with a peer's file.
enum Applied {
    Written,
    /// The on-disk file no longer matched the session's manifest (an autosave
    /// or user edit raced the sync), so the peer's bytes were diverted to a
    /// conflict copy instead of overwriting the fresher local content.
    ConflictCopy,
}

/// Write a peer's `bytes` to `rel` — unless the file changed on disk since the
/// session's manifest recorded `expected_hash` for it. The manifest is built
/// once at session start; re-hashing right before the overwrite closes the
/// window where an edit landing mid-session would be silently lost.
fn apply_incoming(
    vault: &Path,
    rel: &str,
    bytes: &[u8],
    expected_hash: Option<&str>,
) -> CoreResult<Applied> {
    let current = read_vault_bytes(vault, rel)?;
    let safe = match (&current, expected_hash) {
        // Still exactly as the manifest saw it — or already holding the
        // incoming content (e.g. both sides made the same edit).
        (Some(cur), Some(hash)) => hash_hex(cur) == *hash || cur.as_slice() == bytes,
        // Appeared since the manifest was built: only overwrite an identical
        // file (this is also the conflict-copy re-push dedup path).
        (Some(cur), None) => cur.as_slice() == bytes,
        // Absent — as expected, or deleted meanwhile (nothing to lose; deletes
        // are not propagated, so recreating is the established behavior).
        (None, _) => true,
    };
    if safe {
        write_vault_bytes(vault, rel, bytes)?;
        return Ok(Applied::Written);
    }
    let copy = manifest::conflict_copy_path(rel, &hash_tag(bytes));
    log::warn!("sync: {rel} changed during the session; keeping the local edit, writing the peer's version to {copy}");
    write_if_absent(vault, &copy, bytes)?;
    Ok(Applied::ConflictCopy)
}

/// Lowercase-hex SHA-256 of `bytes` (the same fingerprint manifests record).
fn hash_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// First 8 hex chars of the SHA-256 of `bytes` — the content-addressed tag in a
/// conflict-copy filename.
fn hash_tag(bytes: &[u8]) -> String {
    hash_hex(bytes).chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use novalis_core::sync::manifest::FileEntry;

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
        sync_pair_with(init, resp, PeerTrust::Known).await
    }

    /// [`sync_pair`] with an explicit responder-side trust level (to exercise
    /// the vault-key challenge an unknown peer must pass).
    async fn sync_pair_with(
        init: SessionCtx,
        resp: SessionCtx,
        trust: PeerTrust,
    ) -> (SessionOutcome, SessionOutcome) {
        let (a, b) = tokio::io::duplex(1024 * 1024);
        let (mut ar, mut aw) = tokio::io::split(a);
        let (mut br, mut bw) = tokio::io::split(b);

        let responder =
            tokio::spawn(
                async move { run_responder(&mut br, &mut bw, &resp, trust).await.unwrap() },
            );
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
        let responder =
            tokio::spawn(
                async move { run_responder(&mut br, &mut bw, &resp, PeerTrust::Known).await },
            );
        let init_res = run_initiator(&mut ar, &mut aw, &init).await;
        let resp_res = responder.await.unwrap();
        assert!(init_res.is_err(), "initiator must reject a different vault");
        assert!(resp_res.is_err(), "responder must reject a different vault");
    }

    // ── Hardening: challenge, syncable surface, oversize, TOCTOU ───────────

    /// A test manifest entry advertising `content` at `path` (for scripted
    /// peers that never touch a disk).
    fn entry(path: &str, content: &[u8]) -> FileEntry {
        FileEntry {
            path: path.to_string(),
            hash: hash_hex(content),
            size: content.len() as u64,
            mtime_ms: 0,
        }
    }

    #[tokio::test]
    async fn unknown_peer_with_the_vault_key_passes_the_challenge() {
        let key = VaultKey::generate();
        let (_ta, va) = vault_with(&[("a.md", "alpha")]);
        let (_tb, vb) = vault_with(&[]);

        let (ia, ib) = sync_pair_with(
            ctx(va, &key, Manifest::default()),
            ctx(vb.clone(), &key, Manifest::default()),
            PeerTrust::Unknown,
        )
        .await;

        assert!(
            ib.peer_authenticated,
            "a passed challenge must be reported so the caller persists the pairing"
        );
        assert!(!ia.peer_authenticated, "only the responder authenticates");
        assert_eq!(read(&vb, "a.md"), "alpha");
    }

    #[tokio::test]
    async fn known_peer_is_not_challenged() {
        let key = VaultKey::generate();
        let (_ta, va) = vault_with(&[("a.md", "alpha")]);
        let (_tb, vb) = vault_with(&[]);

        let (_ia, ib) = sync_pair(
            ctx(va, &key, Manifest::default()),
            ctx(vb, &key, Manifest::default()),
        )
        .await;
        assert!(!ib.peer_authenticated, "no challenge ran for a known peer");
    }

    #[tokio::test]
    async fn unknown_peer_without_the_vault_key_never_sees_the_manifest() {
        let key = VaultKey::generate();
        let (_tb, vb) = vault_with(&[("secret-name.md", "x")]);
        let resp = ctx(vb, &key, Manifest::default());

        let (a, b) = tokio::io::duplex(64 * 1024);
        let (mut ar, mut aw) = tokio::io::split(a);
        let (mut br, mut bw) = tokio::io::split(b);
        let responder = tokio::spawn(async move {
            run_responder(&mut br, &mut bw, &resp, PeerTrust::Unknown).await
        });

        // A peer with the right vault id but the WRONG key (the vault id is
        // not a secret).
        write_frame(
            &mut aw,
            &Frame::Hello {
                version: PROTOCOL_VERSION,
                vault_id: "vault-under-test".to_string(),
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            read_frame(&mut ar).await.unwrap(),
            Frame::Hello { .. }
        ));
        let nonce = match read_frame(&mut ar).await.unwrap() {
            Frame::Challenge { nonce } => nonce,
            other => panic!("expected a challenge, got {}", frame_name(&other)),
        };
        let wrong_key = VaultKey::generate();
        write_frame(
            &mut aw,
            &Frame::ChallengeResponse {
                sealed: wrong_key.seal(&nonce).unwrap(),
            },
        )
        .await
        .unwrap();

        // The responder must abort without ever sending a manifest.
        assert!(read_frame(&mut ar).await.is_err(), "no manifest may follow");
        let err = responder.await.unwrap().unwrap_err();
        assert!(
            err.to_string().contains("challenge"),
            "must fail the challenge, got: {err}"
        );
    }

    #[tokio::test]
    async fn dot_path_file_data_is_rejected() {
        let key = VaultKey::generate();
        let (_tb, vb) = vault_with(&[]);
        let resp = ctx(vb.clone(), &key, Manifest::default());

        let (a, b) = tokio::io::duplex(64 * 1024);
        let (mut ar, mut aw) = tokio::io::split(a);
        let (mut br, mut bw) = tokio::io::split(b);
        let responder =
            tokio::spawn(
                async move { run_responder(&mut br, &mut bw, &resp, PeerTrust::Known).await },
            );

        write_frame(&mut aw, &hello(&ctx(vb.clone(), &key, Manifest::default())))
            .await
            .unwrap();
        assert!(matches!(
            read_frame(&mut ar).await.unwrap(),
            Frame::Hello { .. }
        ));
        assert!(matches!(
            read_frame(&mut ar).await.unwrap(),
            Frame::Manifest(_)
        ));

        // A correctly sealed write outside the syncable surface (this would be
        // code execution via the plugin loader if applied).
        write_frame(
            &mut aw,
            &Frame::FileData {
                path: ".novalis/plugins-enabled.json".to_string(),
                sealed: key.seal(b"[\"evil\"]").unwrap(),
            },
        )
        .await
        .unwrap();

        assert!(responder.await.unwrap().is_err(), "must refuse the write");
        assert!(
            !vb.join(".novalis/plugins-enabled.json").exists(),
            "nothing may be written outside the syncable surface"
        );
    }

    #[tokio::test]
    async fn dot_path_file_request_is_refused() {
        let key = VaultKey::generate();
        let (_tb, vb) = vault_with(&[]);
        std::fs::create_dir_all(vb.join(".novalis")).unwrap();
        std::fs::write(vb.join(".novalis/internal.json"), "internal").unwrap();
        let resp = ctx(vb.clone(), &key, Manifest::default());

        let (a, b) = tokio::io::duplex(64 * 1024);
        let (mut ar, mut aw) = tokio::io::split(a);
        let (mut br, mut bw) = tokio::io::split(b);
        let responder =
            tokio::spawn(
                async move { run_responder(&mut br, &mut bw, &resp, PeerTrust::Known).await },
            );

        write_frame(&mut aw, &hello(&ctx(vb.clone(), &key, Manifest::default())))
            .await
            .unwrap();
        assert!(matches!(
            read_frame(&mut ar).await.unwrap(),
            Frame::Hello { .. }
        ));
        assert!(matches!(
            read_frame(&mut ar).await.unwrap(),
            Frame::Manifest(_)
        ));

        write_frame(
            &mut aw,
            &Frame::FileRequest {
                path: ".novalis/internal.json".to_string(),
            },
        )
        .await
        .unwrap();

        assert!(responder.await.unwrap().is_err(), "must refuse the read");
    }

    #[tokio::test]
    async fn oversized_take_is_skipped_not_fatal() {
        let key = VaultKey::generate();
        let (_ta, va) = vault_with(&[]);
        let init = ctx(va, &key, Manifest::default());

        let (a, b) = tokio::io::duplex(1024 * 1024);
        let (mut ar, mut aw) = tokio::io::split(a);
        let (mut br, mut bw) = tokio::io::split(b);

        // Scripted responder advertising a file too large to ever frame.
        let peer = tokio::spawn(async move {
            assert!(matches!(
                read_frame(&mut br).await.unwrap(),
                Frame::Hello { .. }
            ));
            write_frame(
                &mut bw,
                &Frame::Hello {
                    version: PROTOCOL_VERSION,
                    vault_id: "vault-under-test".to_string(),
                },
            )
            .await
            .unwrap();
            let mut m = Manifest::default();
            let mut big = entry("big.pdf", b"");
            big.size = MAX_FILE + 1;
            m.entries.insert("big.pdf".to_string(), big);
            write_frame(&mut bw, &Frame::Manifest(m)).await.unwrap();
            // The initiator must skip the oversized take: next frame is Done,
            // never a FileRequest that would end in a session-killing frame.
            assert!(matches!(read_frame(&mut br).await.unwrap(), Frame::Done));
        });

        let out = run_initiator(&mut ar, &mut aw, &init).await.unwrap();
        peer.await.unwrap();
        assert_eq!(out.skipped_oversize, 1);
        assert_eq!(out.taken, 0);
        assert!(
            !out.new_base.entries.contains_key("big.pdf"),
            "a skipped file must not enter the base as synced"
        );
    }

    #[tokio::test]
    async fn oversized_send_is_skipped_and_small_files_still_sync() {
        let key = VaultKey::generate();
        let (_ta, va) = vault_with(&[("a.md", "small")]);
        std::fs::write(va.join("big.bin"), vec![0u8; (MAX_FILE + 1) as usize]).unwrap();
        let (_tb, vb) = vault_with(&[]);

        let (ia, _ib) = sync_pair(
            ctx(va, &key, Manifest::default()),
            ctx(vb.clone(), &key, Manifest::default()),
        )
        .await;

        assert_eq!(ia.sent, 1, "the small file still syncs");
        assert_eq!(ia.skipped_oversize, 1);
        assert_eq!(read(&vb, "a.md"), "small");
        assert!(!vb.join("big.bin").exists());
        assert!(
            !ia.new_base.entries.contains_key("big.bin"),
            "a skipped file must not enter the base as synced"
        );
    }

    #[tokio::test]
    async fn oversized_file_request_gets_file_missing_not_a_dead_session() {
        let key = VaultKey::generate();
        let (_tb, vb) = vault_with(&[]);
        std::fs::write(vb.join("big.bin"), vec![0u8; (MAX_FILE + 1) as usize]).unwrap();
        let resp = ctx(vb.clone(), &key, Manifest::default());

        let (a, b) = tokio::io::duplex(1024 * 1024);
        let (mut ar, mut aw) = tokio::io::split(a);
        let (mut br, mut bw) = tokio::io::split(b);
        let responder =
            tokio::spawn(
                async move { run_responder(&mut br, &mut bw, &resp, PeerTrust::Known).await },
            );

        write_frame(&mut aw, &hello(&ctx(vb.clone(), &key, Manifest::default())))
            .await
            .unwrap();
        assert!(matches!(
            read_frame(&mut ar).await.unwrap(),
            Frame::Hello { .. }
        ));
        assert!(matches!(
            read_frame(&mut ar).await.unwrap(),
            Frame::Manifest(_)
        ));

        write_frame(
            &mut aw,
            &Frame::FileRequest {
                path: "big.bin".to_string(),
            },
        )
        .await
        .unwrap();
        assert!(
            matches!(
                read_frame(&mut ar).await.unwrap(),
                Frame::FileMissing { .. }
            ),
            "an oversized request must be answered, not kill the session"
        );
        write_frame(&mut aw, &Frame::Done).await.unwrap();

        let out = responder.await.unwrap().unwrap();
        assert_eq!(out.skipped_oversize, 1);
        assert_eq!(out.sent, 0);
    }

    #[tokio::test]
    async fn take_raced_by_local_edit_lands_as_conflict_copy() {
        let key = VaultKey::generate();
        let (_ta, va) = vault_with(&[("Note.md", "base")]);
        let base = Manifest::build(&va).unwrap();
        let init = ctx(va.clone(), &key, base.clone());

        let (a, b) = tokio::io::duplex(1024 * 1024);
        let (mut ar, mut aw) = tokio::io::split(a);
        let (mut br, mut bw) = tokio::io::split(b);

        // Scripted responder that sneaks a local edit into the INITIATOR's
        // vault between its manifest build and the overwrite (the TOCTOU
        // window an autosave can hit).
        let va2 = va.clone();
        let key2 = key.clone();
        let peer = tokio::spawn(async move {
            assert!(matches!(
                read_frame(&mut br).await.unwrap(),
                Frame::Hello { .. }
            ));
            write_frame(
                &mut bw,
                &Frame::Hello {
                    version: PROTOCOL_VERSION,
                    vault_id: "vault-under-test".to_string(),
                },
            )
            .await
            .unwrap();
            let mut m = Manifest::default();
            m.entries
                .insert("Note.md".to_string(), entry("Note.md", b"theirs"));
            write_frame(&mut bw, &Frame::Manifest(m)).await.unwrap();
            // The initiator has built its local manifest by the time it asks.
            assert!(matches!(
                read_frame(&mut br).await.unwrap(),
                Frame::FileRequest { .. }
            ));
            std::fs::write(va2.join("Note.md"), "user edit").unwrap();
            write_frame(
                &mut bw,
                &Frame::FileData {
                    path: "Note.md".to_string(),
                    sealed: key2.seal(b"theirs").unwrap(),
                },
            )
            .await
            .unwrap();
            assert!(matches!(read_frame(&mut br).await.unwrap(), Frame::Done));
        });

        let out = run_initiator(&mut ar, &mut aw, &init).await.unwrap();
        peer.await.unwrap();

        assert_eq!(out.taken, 0);
        assert_eq!(out.conflicts, vec!["Note.md".to_string()]);
        // The racing edit survives; the peer's version lands as a copy.
        assert_eq!(read(&va, "Note.md"), "user edit");
        assert!(novalis_core::conflict::list_conflicts(&va)
            .iter()
            .any(|c| c.original_path == "Note.md"));
        // Base reverted so the divergence re-surfaces next cycle.
        assert_eq!(
            out.new_base.entries["Note.md"].hash,
            base.entries["Note.md"].hash
        );
    }

    #[tokio::test]
    async fn pushed_file_raced_by_local_edit_lands_as_conflict_copy() {
        let key = VaultKey::generate();
        let (_tb, vb) = vault_with(&[("Note.md", "old")]);
        let resp = ctx(vb.clone(), &key, Manifest::default());

        let (a, b) = tokio::io::duplex(1024 * 1024);
        let (mut ar, mut aw) = tokio::io::split(a);
        let (mut br, mut bw) = tokio::io::split(b);
        let responder =
            tokio::spawn(
                async move { run_responder(&mut br, &mut bw, &resp, PeerTrust::Known).await },
            );

        write_frame(&mut aw, &hello(&ctx(vb.clone(), &key, Manifest::default())))
            .await
            .unwrap();
        assert!(matches!(
            read_frame(&mut ar).await.unwrap(),
            Frame::Hello { .. }
        ));
        // Once the manifest arrives the responder has snapshotted its vault.
        assert!(matches!(
            read_frame(&mut ar).await.unwrap(),
            Frame::Manifest(_)
        ));
        // The racing local edit on the responder...
        std::fs::write(vb.join("Note.md"), "user edit").unwrap();
        // ...then the initiator's push for the same file arrives.
        write_frame(
            &mut aw,
            &Frame::FileData {
                path: "Note.md".to_string(),
                sealed: key.seal(b"incoming").unwrap(),
            },
        )
        .await
        .unwrap();
        write_frame(&mut aw, &Frame::Done).await.unwrap();

        let out = responder.await.unwrap().unwrap();
        assert_eq!(out.taken, 0);
        assert_eq!(out.conflicts, vec!["Note.md".to_string()]);
        assert_eq!(read(&vb, "Note.md"), "user edit");
        assert!(novalis_core::conflict::list_conflicts(&vb)
            .iter()
            .any(|c| c.original_path == "Note.md"));
    }
}
