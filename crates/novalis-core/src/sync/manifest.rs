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

impl Manifest {
    /// Hash every non-hidden file under `vault` into a manifest. Skips dot
    /// files/dirs (so `.novalis/`, `.git/`, and atomic-write temp files are
    /// excluded — matching the vault walker elsewhere). Unreadable files are
    /// skipped with a log line rather than failing the whole scan.
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
    /// deliberately (see the module docs / SYNC_P2P.md). The session reports a
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
    fn identical_files_yield_no_action() {
        let m = manifest(&[("a.md", "same")]);
        assert!(plan(&m, &m, &m).is_empty());
    }

    #[test]
    fn new_local_file_is_sent() {
        let base = Manifest::default();
        let local = manifest(&[("new.md", "hi")]);
        let remote = Manifest::default();
        assert_eq!(plan(&base, &local, &remote), vec![FileAction::Send("new.md".into())]);
    }

    #[test]
    fn new_remote_file_is_taken() {
        let base = Manifest::default();
        let local = Manifest::default();
        let remote = manifest(&[("new.md", "hi")]);
        assert_eq!(plan(&base, &local, &remote), vec![FileAction::Take("new.md".into())]);
    }

    #[test]
    fn local_only_edit_is_sent() {
        let base = manifest(&[("a.md", "v1")]);
        let local = manifest(&[("a.md", "v2")]);
        let remote = manifest(&[("a.md", "v1")]);
        assert_eq!(plan(&base, &local, &remote), vec![FileAction::Send("a.md".into())]);
    }

    #[test]
    fn remote_only_edit_is_taken() {
        let base = manifest(&[("a.md", "v1")]);
        let local = manifest(&[("a.md", "v1")]);
        let remote = manifest(&[("a.md", "v2")]);
        assert_eq!(plan(&base, &local, &remote), vec![FileAction::Take("a.md".into())]);
    }

    #[test]
    fn both_edited_differently_conflicts() {
        let base = manifest(&[("a.md", "v1")]);
        let local = manifest(&[("a.md", "mine")]);
        let remote = manifest(&[("a.md", "theirs")]);
        assert_eq!(plan(&base, &local, &remote), vec![FileAction::Conflict("a.md".into())]);
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
        assert_eq!(plan(&base, &local, &remote), vec![FileAction::Conflict("a.md".into())]);
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
        assert_eq!(plan(&base, &local, &remote), vec![FileAction::Conflict("a.md".into())]);
    }

    #[test]
    fn converged_deletion_is_noop() {
        let base = manifest(&[("a.md", "v1")]);
        let local = Manifest::default();
        let remote = Manifest::default();
        assert!(plan(&base, &local, &remote).is_empty());
    }
}
