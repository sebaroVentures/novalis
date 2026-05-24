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
    let abs = vault.join(relative);
    if !abs.exists() {
        return search::remove_note(db, relative);
    }
    let summary = vault_fs::build_summary(vault, relative)?;
    let content = std::fs::read_to_string(&abs)?;
    search::index_note(db, &summary, &content)
}

/// Remove a note from the index (used on delete/move-away).
pub fn remove(db: &Connection, relative: &str) -> CoreResult<()> {
    search::remove_note(db, relative)
}
