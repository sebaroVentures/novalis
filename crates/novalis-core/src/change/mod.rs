//! Unified index-change handling.
//!
//! Both the desktop file watcher (push) and a manual rescan / mobile
//! foreground-refresh (pull) funnel through [`reindex_path`], so there is one
//! code path for "a note at this path changed — make the index reflect it."

use std::path::Path;

use rusqlite::Connection;

use crate::error::CoreResult;
use crate::index::search;
use crate::vault::fs as vault_fs;

/// Re-index the note at `relative`, or remove it from the index if the file no
/// longer exists on disk.
pub fn reindex_path(db: &Connection, vault: &Path, relative: &str) -> CoreResult<()> {
    let abs = vault_fs::vault_rel(vault, relative)?;
    if !abs.exists() {
        return search::remove_note(db, relative);
    }
    let summary = vault_fs::build_summary(vault, relative)?;
    let content = std::fs::read_to_string(&abs)?;
    search::index_note(db, &summary, &content)?;
    // Stamp the on-disk mtime so the incremental startup scan can skip this note
    // next time (a watcher/rescan reindex otherwise leaves mtime unstamped,
    // forcing a needless reindex at the following open).
    if let Some(ms) = std::fs::metadata(&abs)
        .ok()
        .as_ref()
        .and_then(vault_fs::file_mtime_ms)
    {
        search::stamp_mtime(db, relative, ms)?;
    }
    Ok(())
}

/// Remove a note from the index (used on delete/move-away).
pub fn remove(db: &Connection, relative: &str) -> CoreResult<()> {
    search::remove_note(db, relative)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{list_summaries, schema};

    fn ctx() -> (tempfile::TempDir, Connection) {
        let base = tempfile::tempdir().unwrap();
        let db = schema::open_db(&base.path().join("notes.db")).unwrap();
        (base, db)
    }

    fn indexed_paths(db: &Connection) -> Vec<String> {
        list_summaries(db)
            .unwrap()
            .into_iter()
            .map(|s| s.path)
            .collect()
    }

    #[test]
    fn reindex_path_indexes_a_note_on_disk() {
        let (vault, db) = ctx();
        std::fs::write(
            vault.path().join("n.md"),
            "---\ntitle: N\n---\n\nkingfisher sighting\n",
        )
        .unwrap();

        reindex_path(&db, vault.path(), "n.md").unwrap();

        assert_eq!(indexed_paths(&db), ["n.md"]);
        // The body is in the FTS index too.
        let hits = search::search(&db, "kingfisher", None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "n.md");
    }

    #[test]
    fn reindex_path_removes_a_note_missing_from_disk() {
        let (vault, db) = ctx();
        std::fs::write(vault.path().join("n.md"), "body").unwrap();
        reindex_path(&db, vault.path(), "n.md").unwrap();
        assert_eq!(indexed_paths(&db), ["n.md"]);

        // The push/pull funnel: a watcher event for a deleted file must drop
        // it from the index rather than error.
        std::fs::remove_file(vault.path().join("n.md")).unwrap();
        reindex_path(&db, vault.path(), "n.md").unwrap();
        assert!(indexed_paths(&db).is_empty());
    }

    #[test]
    fn remove_drops_the_index_entry_but_not_the_file() {
        let (vault, db) = ctx();
        std::fs::write(vault.path().join("n.md"), "body").unwrap();
        reindex_path(&db, vault.path(), "n.md").unwrap();

        remove(&db, "n.md").unwrap();

        assert!(indexed_paths(&db).is_empty());
        assert!(vault.path().join("n.md").exists());
    }
}
