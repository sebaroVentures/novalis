//! A **manifest** is a content fingerprint of every syncable file in the vault
//! (path → hash + size + mtime), plus the 3-way *plan* that decides, for each
//! file, what a sync should do.
//!
//! ## Why 3-way
//! With only two manifests you cannot tell "I changed this file" from "they
//! changed it" — so you'd either overwrite (silent data loss, the thing we
//! exist to avoid) or flag every legitimate edit as a conflict. So a sync
//! remembers the **base**: the manifest as it stood after the last successful
//! sync with that peer. Comparing base/local/remote per file gives git-like
//! semantics at file granularity:
//!
//! | base | local | remote | verdict                        |
//! |------|-------|--------|--------------------------------|
//! | =    | =     | ≠      | remote changed → **take**      |
//! | =    | ≠     | =      | local changed → **send**       |
//! | =    | ≠     | ≠ (and local≠remote) | both changed → **conflict** |
//! | —    | new   | —      | new locally → **send**         |
//! | —    | —     | new    | new remotely → **take**        |
//! | —    | new   | new (differ) | independent creates → **conflict** |
//!
//! Sub-file merge (CRDT/automerge) — which would turn many of those conflicts
//! into clean merges — is the documented next step and is *not* implemented;
//! conflicts here are surfaced, never silently resolved.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::error::CoreResult;

/// One file's fingerprint in a [`Manifest`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileEntry {
    /// Vault-relative, forward-slashed path.
    pub path: String,
    /// Lowercase-hex SHA-256 of the file's bytes.
    pub hash: String,
    pub size: u64,
    /// Modification time, epoch milliseconds (advisory — the plan keys off the
    /// hash, mtime is only a tiebreaker hint the UI may show).
    pub mtime_ms: i64,
}

/// A content fingerprint of the whole vault, keyed by path for O(log n) diff.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub entries: BTreeMap<String, FileEntry>,
}

/// Whether a vault-relative path is part of the **syncable surface**. The one
/// definition shared by [`Manifest::build`] and the session's file read/write
/// paths, so what a peer can read or write is exactly what a manifest can
/// advertise: no hidden components (`.novalis/`, `.git/`, dotfiles, atomic-
/// write temps) and nothing that could step outside the vault (`..` also
/// starts with a dot; empty components reject absolute/doubled slashes;
/// backslashes are rejected so no separator sneaks past on any platform).
/// Defense in depth on top of `vault_rel`'s escape check.
pub fn is_syncable_rel(rel: &str) -> bool {
    !rel.is_empty()
        && rel
            .split('/')
            .all(|c| !c.is_empty() && !c.starts_with('.') && !c.contains('\\'))
}

impl Manifest {
    /// Hash every syncable file under `vault` into a manifest. Skips whatever
    /// [`is_syncable_rel`] excludes (dot files/dirs, so `.novalis/`, `.git/`,
    /// and atomic-write temp files — matching the vault walker elsewhere).
    /// Unreadable files are skipped with a log line rather than failing the
    /// whole scan.
    pub fn build(vault: &Path) -> CoreResult<Manifest> {
        let mut entries = BTreeMap::new();
        for entry in WalkDir::new(vault)
            .into_iter()
            .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(vault)
                .unwrap_or(entry.path())
                .to_string_lossy()
                .replace('\\', "/");
            // The walker's filter is an optimization; this is the contract.
            if !is_syncable_rel(&rel) {
                continue;
            }
            let bytes = match std::fs::read(entry.path()) {
                Ok(b) => b,
                Err(e) => {
                    log::warn!("sync: skipping unreadable file {rel}: {e}");
                    continue;
                }
            };
            let meta = entry.metadata().ok();
            let mtime_ms = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .map(|t| chrono::DateTime::<chrono::Utc>::from(t).timestamp_millis())
                .unwrap_or(0);
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            entries.insert(
                rel.clone(),
                FileEntry {
                    path: rel,
                    hash: format!("{:x}", hasher.finalize()),
                    size: bytes.len() as u64,
                    mtime_ms,
                },
            );
        }
        Ok(Manifest { entries })
    }

    /// The set of paths, for diffing.
    fn paths(&self) -> BTreeSet<&String> {
        self.entries.keys().collect()
    }

    fn hash_of(&self, path: &str) -> Option<&str> {
        self.entries.get(path).map(|e| e.hash.as_str())
    }
}

/// One decision the [`plan`] produced for a single path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileAction {
    /// Local content should be sent to the peer (new locally, or changed only
    /// locally since the base).
    Send(String),
    /// The peer's content should be written locally (new remotely, or changed
    /// only remotely since the base).
    Take(String),
    /// Both sides changed the file to different content since the base — a true
    /// conflict. Surfaced (never silently merged): the peer's version is
    /// written as a conflict copy alongside the local one.
    Conflict(String),
    /// The file was deleted on one side and unchanged on the other. **Detected
    /// but not applied** in this foundation — propagating deletes over a sync
    /// the tests can't yet fully exercise is a destructive operation held back
    /// deliberately (see the module docs above). The session reports a
    /// count so the boundary is visible, and takes no action.
    DeletePending(String),
}

/// Compute the per-file plan from the three manifests. `base` is the last
/// synced state with this peer (empty on the first sync). Pure and total: every
/// path that appears in any of the three is accounted for.
pub fn plan(base: &Manifest, local: &Manifest, remote: &Manifest) -> Vec<FileAction> {
    let mut all: BTreeSet<&String> = BTreeSet::new();
    all.extend(local.paths());
    all.extend(remote.paths());
    all.extend(base.paths());

    let mut actions = Vec::new();
    for path in all {
        let b = base.hash_of(path);
        let l = local.hash_of(path);
        let r = remote.hash_of(path);

        match (l, r) {
            // Present and identical on both sides — nothing to do.
            (Some(lh), Some(rh)) if lh == rh => {}

            // Present on both, but different content.
            (Some(lh), Some(rh)) => {
                let local_changed = b != Some(lh);
                let remote_changed = b != Some(rh);
                match (local_changed, remote_changed) {
                    // Only remote moved since the base → adopt theirs.
                    (false, true) => actions.push(FileAction::Take(path.clone())),
                    // Only local moved → send ours.
                    (true, false) => actions.push(FileAction::Send(path.clone())),
                    // Both moved to different content (or no base) → conflict.
                    _ => actions.push(FileAction::Conflict(path.clone())),
                }
            }

            // Only local has it.
            (Some(lh), None) => match b {
                // Never in the base → a local create → send it.
                None => actions.push(FileAction::Send(path.clone())),
                // Was in the base unchanged, now gone remotely → remote delete.
                Some(bh) if bh == lh => actions.push(FileAction::DeletePending(path.clone())),
                // Was in the base, locally edited, remotely deleted → conflict.
                Some(_) => actions.push(FileAction::Conflict(path.clone())),
            },

            // Only remote has it (mirror of the above).
            (None, Some(rh)) => match b {
                None => actions.push(FileAction::Take(path.clone())),
                Some(bh) if bh == rh => actions.push(FileAction::DeletePending(path.clone())),
                Some(_) => actions.push(FileAction::Conflict(path.clone())),
            },

            // Gone on both sides — converged deletion, nothing to do.
            (None, None) => {}
        }
    }
    actions
}

/// Build the vault-relative path of a "conflict copy" for a diverged file,
/// inserting a `(peer's conflicted copy <tag>)` marker before the extension.
///
/// The marker is shaped to match the EXISTING conflict detector's
/// `'s conflicted copy` regex ([`crate::conflict`]) so a diverged P2P file is
/// surfaced in the very same resolver used for OneDrive/Dropbox conflicts — no
/// new UI. `tag` is a content-hash prefix (deterministic), so re-running a sync
/// on an unresolved conflict rewrites the *same* name instead of spamming
/// timestamped copies — free dedup.
pub fn conflict_copy_path(rel: &str, tag: &str) -> String {
    let (dir, name) = match rel.rfind('/') {
        Some(i) => (&rel[..=i], &rel[i + 1..]),
        None => ("", rel),
    };
    // Split the extension off, but keep a leading-dot name (e.g. no stem) whole.
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    format!("{dir}{stem} (peer's conflicted copy {tag}){ext}")
}

/// The base manifest to persist after a sync cycle, derived from the same
/// three-way verdict as [`plan`]. Pure so the "next sync doesn't re-flag a
/// clean file" and "a deferred delete never resurrects" invariants are tested
/// directly. Rules per path:
/// - transferred (send/take): record the now-shared hash so it's clean next
///   time;
/// - already-identical: record that hash;
/// - conflict: **omit** — the file stays un-based so it re-surfaces (never
///   auto-resolves, never overwrites) until the user reconciles it;
/// - delete-pending: **retain** the old base entry, which both keeps the file
///   from resurrecting on the deleting side and keeps it "pending" (not
///   deleted) on the other — matching the deferred-delete boundary;
/// - gone on both sides: drop.
pub fn next_base(base: &Manifest, local: &Manifest, remote: &Manifest) -> Manifest {
    let mut all: BTreeSet<&String> = BTreeSet::new();
    all.extend(local.paths());
    all.extend(remote.paths());
    all.extend(base.paths());

    let mut out = Manifest::default();
    let mut keep = |e: &FileEntry| {
        out.entries.insert(e.path.clone(), e.clone());
    };

    for path in all {
        let le = local.entries.get(path);
        let re = remote.entries.get(path);
        let be = base.entries.get(path);
        let b = be.map(|e| e.hash.as_str());

        match (le, re) {
            (Some(l), Some(r)) if l.hash == r.hash => keep(l),
            (Some(l), Some(r)) => {
                let local_changed = b != Some(l.hash.as_str());
                let remote_changed = b != Some(r.hash.as_str());
                match (local_changed, remote_changed) {
                    (false, true) => keep(r), // take
                    (true, false) => keep(l), // send
                    _ => {}                   // conflict → omit
                }
            }
            (Some(l), None) => match b {
                None => keep(l),                               // local create → sent
                Some(bh) if bh == l.hash => keep(be.unwrap()), // delete pending → retain
                Some(_) => {}                                  // delete vs edit → omit
            },
            (None, Some(r)) => match b {
                None => keep(r),                               // remote create → taken
                Some(bh) if bh == r.hash => keep(be.unwrap()), // delete pending → retain
                Some(_) => {}
            },
            (None, None) => {} // gone on both → drop
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn manifest(files: &[(&str, &str)]) -> Manifest {
        let entries = files
            .iter()
            .map(|(p, content)| {
                let mut h = Sha256::new();
                h.update(content.as_bytes());
                (
                    p.to_string(),
                    FileEntry {
                        path: p.to_string(),
                        hash: format!("{:x}", h.finalize()),
                        size: content.len() as u64,
                        mtime_ms: 0,
                    },
                )
            })
            .collect();
        Manifest { entries }
    }

    fn temp_vault() -> (tempfile::TempDir, PathBuf) {
        let base = tempfile::tempdir().unwrap();
        let vault = base.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        (base, vault)
    }

    #[test]
    fn build_hashes_files_and_skips_hidden() {
        let (_tmp, vault) = temp_vault();
        std::fs::write(vault.join("a.md"), "alpha").unwrap();
        std::fs::create_dir_all(vault.join(".novalis")).unwrap();
        std::fs::write(vault.join(".novalis/state.json"), "internal").unwrap();
        std::fs::write(vault.join(".hidden"), "x").unwrap();

        let m = Manifest::build(&vault).unwrap();
        assert_eq!(m.entries.len(), 1, "only a.md is syncable");
        assert!(m.entries.contains_key("a.md"));
    }

    #[test]
    fn is_syncable_rel_defines_the_surface() {
        for ok in ["a.md", "notes/deep/b.md", "media/img.png"] {
            assert!(is_syncable_rel(ok), "{ok} must be syncable");
        }
        for bad in [
            "",
            ".novalis/plugins-enabled.json",
            ".novalis/plugins/evil/main.js",
            "notes/.hidden.md",
            ".git/config",
            "../outside.md",
            "notes/../../outside.md",
            "/abs/path.md",
            "notes//gap.md",
            "notes\\win.md",
            ".Note.md.123.sync-tmp",
        ] {
            assert!(!is_syncable_rel(bad), "{bad:?} must NOT be syncable");
        }
    }

    #[test]
    fn identical_files_yield_no_action() {
        let m = manifest(&[("a.md", "same")]);
        assert!(plan(&m, &m, &m).is_empty());
    }

    #[test]
    fn new_local_file_is_sent() {
        let base = Manifest::default();
        let local = manifest(&[("new.md", "hi")]);
        let remote = Manifest::default();
        assert_eq!(
            plan(&base, &local, &remote),
            vec![FileAction::Send("new.md".into())]
        );
    }

    #[test]
    fn new_remote_file_is_taken() {
        let base = Manifest::default();
        let local = Manifest::default();
        let remote = manifest(&[("new.md", "hi")]);
        assert_eq!(
            plan(&base, &local, &remote),
            vec![FileAction::Take("new.md".into())]
        );
    }

    #[test]
    fn local_only_edit_is_sent() {
        let base = manifest(&[("a.md", "v1")]);
        let local = manifest(&[("a.md", "v2")]);
        let remote = manifest(&[("a.md", "v1")]);
        assert_eq!(
            plan(&base, &local, &remote),
            vec![FileAction::Send("a.md".into())]
        );
    }

    #[test]
    fn remote_only_edit_is_taken() {
        let base = manifest(&[("a.md", "v1")]);
        let local = manifest(&[("a.md", "v1")]);
        let remote = manifest(&[("a.md", "v2")]);
        assert_eq!(
            plan(&base, &local, &remote),
            vec![FileAction::Take("a.md".into())]
        );
    }

    #[test]
    fn both_edited_differently_conflicts() {
        let base = manifest(&[("a.md", "v1")]);
        let local = manifest(&[("a.md", "mine")]);
        let remote = manifest(&[("a.md", "theirs")]);
        assert_eq!(
            plan(&base, &local, &remote),
            vec![FileAction::Conflict("a.md".into())]
        );
    }

    #[test]
    fn both_created_same_content_is_noop() {
        // Independent creates of byte-identical files converge silently.
        let base = Manifest::default();
        let local = manifest(&[("a.md", "same")]);
        let remote = manifest(&[("a.md", "same")]);
        assert!(plan(&base, &local, &remote).is_empty());
    }

    #[test]
    fn both_created_different_content_conflicts() {
        let base = Manifest::default();
        let local = manifest(&[("a.md", "mine")]);
        let remote = manifest(&[("a.md", "theirs")]);
        assert_eq!(
            plan(&base, &local, &remote),
            vec![FileAction::Conflict("a.md".into())]
        );
    }

    #[test]
    fn remote_deleted_unchanged_local_is_delete_pending() {
        let base = manifest(&[("a.md", "v1")]);
        let local = manifest(&[("a.md", "v1")]);
        let remote = Manifest::default();
        assert_eq!(
            plan(&base, &local, &remote),
            vec![FileAction::DeletePending("a.md".into())]
        );
    }

    #[test]
    fn delete_vs_edit_conflicts() {
        let base = manifest(&[("a.md", "v1")]);
        let local = manifest(&[("a.md", "edited")]); // edited locally
        let remote = Manifest::default(); // deleted remotely
        assert_eq!(
            plan(&base, &local, &remote),
            vec![FileAction::Conflict("a.md".into())]
        );
    }

    #[test]
    fn converged_deletion_is_noop() {
        let base = manifest(&[("a.md", "v1")]);
        let local = Manifest::default();
        let remote = Manifest::default();
        assert!(plan(&base, &local, &remote).is_empty());
    }

    #[test]
    fn conflict_copy_path_inserts_marker_before_extension() {
        assert_eq!(
            conflict_copy_path("notes/Foo.md", "a1b2c3d4"),
            "notes/Foo (peer's conflicted copy a1b2c3d4).md"
        );
        assert_eq!(
            conflict_copy_path("Bar.md", "deadbeef"),
            "Bar (peer's conflicted copy deadbeef).md"
        );
        // Extensionless files keep the marker at the end.
        assert_eq!(
            conflict_copy_path("LICENSE", "cafe"),
            "LICENSE (peer's conflicted copy cafe)"
        );
    }

    #[test]
    fn conflict_copy_is_surfaced_by_the_existing_detector() {
        // The whole point of the naming: reuse crate::conflict's resolver.
        let (_tmp, vault) = temp_vault();
        std::fs::write(vault.join("Foo.md"), "mine").unwrap();
        let copy = conflict_copy_path("Foo.md", "abc12345");
        std::fs::write(vault.join(&copy), "theirs").unwrap();

        let conflicts = crate::conflict::list_conflicts(&vault);
        assert_eq!(
            conflicts.len(),
            1,
            "detector must see the P2P conflict copy"
        );
        assert_eq!(conflicts[0].original_path, "Foo.md");
        assert_eq!(conflicts[0].conflict_path, copy);
    }

    #[test]
    fn next_base_records_transfers_and_omits_conflicts() {
        // send: local edited only → base adopts local hash.
        let base = manifest(&[("s.md", "v1"), ("t.md", "v1"), ("c.md", "v1")]);
        let local = manifest(&[("s.md", "v2"), ("t.md", "v1"), ("c.md", "mine")]);
        let remote = manifest(&[("s.md", "v1"), ("t.md", "v2"), ("c.md", "theirs")]);
        let nb = next_base(&base, &local, &remote);
        // s.md sent → base = local v2; t.md taken → base = remote v2.
        assert_eq!(nb.entries["s.md"].hash, local.entries["s.md"].hash);
        assert_eq!(nb.entries["t.md"].hash, remote.entries["t.md"].hash);
        // c.md conflicted → omitted so it re-surfaces, never auto-resolves.
        assert!(!nb.entries.contains_key("c.md"));
    }

    #[test]
    fn next_base_retains_delete_pending_to_prevent_resurrection() {
        // Local deleted a file the peer still has (unchanged). Base must KEEP
        // the entry, else the next sync would re-download (resurrect) it.
        let base = manifest(&[("gone.md", "v1")]);
        let local = Manifest::default();
        let remote = manifest(&[("gone.md", "v1")]);
        let nb = next_base(&base, &local, &remote);
        assert!(
            nb.entries.contains_key("gone.md"),
            "delete-pending must retain its base entry"
        );
        // And it stays delete-pending (not a Take) on the following cycle.
        assert_eq!(
            plan(&nb, &local, &remote),
            vec![FileAction::DeletePending("gone.md".into())]
        );
    }

    #[test]
    fn next_base_drops_converged_deletions() {
        let base = manifest(&[("a.md", "v1")]);
        let nb = next_base(&base, &Manifest::default(), &Manifest::default());
        assert!(nb.entries.is_empty());
    }

    #[test]
    fn next_base_makes_a_clean_sync_a_noop_next_time() {
        // After first sync of a new local file, base should record it so the
        // next plan is empty.
        let base = Manifest::default();
        let local = manifest(&[("a.md", "hi")]);
        let remote = Manifest::default();
        let nb = next_base(&base, &local, &remote);
        // Peer now also has it; simulate remote == local next round.
        assert!(plan(&nb, &local, &local).is_empty());
    }
}
