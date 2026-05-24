//! The local SQLite index: a disposable, rebuildable cache (in app-data, never
//! the vault) holding note metadata, an FTS5 full-text index, and the
//! `[[wikilink]]` graph. The `tasks` table is created here but only populated
//! starting in M2.

pub mod links;
pub mod schema;
pub mod search;

use rusqlite::Statement;

use crate::error::CoreResult;
use crate::models::NoteSummary;

/// Map `note_meta` rows (selected in a fixed column order) to [`NoteSummary`].
/// Shared by quick search, backlinks, and unlinked mentions.
pub(crate) fn rows_to_summaries(
    stmt: &mut Statement,
    params: impl rusqlite::Params,
) -> CoreResult<Vec<NoteSummary>> {
    let results = stmt
        .query_map(params, |row| {
            let tags_str: String = row.get(3)?;
            let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
            Ok(NoteSummary {
                path: row.get(0)?,
                title: row.get(1)?,
                folder: row.get(2)?,
                tags,
                created: row.get(4)?,
                modified: row.get(5)?,
                pinned: row.get::<_, i32>(6)? != 0,
                word_count: row.get::<_, i64>(7)? as usize,
                task_total: row.get::<_, i64>(8)? as usize,
                task_completed: row.get::<_, i64>(9)? as usize,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(results)
}
