//! The local SQLite index: a disposable, rebuildable cache (in app-data, never
//! the vault) holding note metadata, an FTS5 full-text index, and the
//! `[[wikilink]]` graph. The `tasks` table is created here but only populated
//! starting in M2.

pub mod events;
pub mod links;
pub mod schema;
pub mod search;
pub mod vectors;

use rusqlite::{Connection, Statement};

use crate::error::CoreResult;
use crate::models::NoteSummary;

/// All note summaries straight from the index — no disk reads. Used to build
/// the folder tree without reading (or hydrating) every file in the vault.
pub fn list_summaries(db: &Connection) -> CoreResult<Vec<NoteSummary>> {
    let mut stmt = db.prepare(
        "SELECT path, title, folder, tags, created, modified, pinned, word_count, task_total, task_completed, cloud_only, aliases
         FROM note_meta",
    )?;
    rows_to_summaries(&mut stmt, [])
}

/// Map `note_meta` rows (selected in a fixed column order) to [`NoteSummary`].
/// Shared by the folder tree and quick search.
pub(crate) fn rows_to_summaries(
    stmt: &mut Statement,
    params: impl rusqlite::Params,
) -> CoreResult<Vec<NoteSummary>> {
    let results = stmt
        .query_map(params, |row| {
            let tags_str: String = row.get(3)?;
            let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
            // `aliases` is appended last in the SELECT column order (index 11).
            let aliases_str: String = row.get(11)?;
            let aliases: Vec<String> = serde_json::from_str(&aliases_str).unwrap_or_default();
            Ok(NoteSummary {
                path: row.get(0)?,
                title: row.get(1)?,
                folder: row.get(2)?,
                tags,
                aliases,
                created: row.get(4)?,
                modified: row.get(5)?,
                pinned: row.get::<_, i32>(6)? != 0,
                word_count: row.get::<_, i64>(7)? as usize,
                task_total: row.get::<_, i64>(8)? as usize,
                task_completed: row.get::<_, i64>(9)? as usize,
                cloud_only: row.get::<_, i32>(10)? != 0,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(results)
}
