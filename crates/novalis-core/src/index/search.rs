//! Building/updating the index and full-text search.

use std::path::Path;

use rusqlite::{params, Connection};

use crate::error::CoreResult;
use crate::index::links;
use crate::models::{NoteSummary, SearchResult, TagCount};
use crate::vault::{frontmatter, fs as vault_fs};

/// Full scan of the vault to (re)build the search index.
pub fn build_index(db: &Connection, vault: &Path) -> CoreResult<()> {
    log::info!("building full search index for vault: {}", vault.display());

    // One transaction for the whole rebuild: the per-statement autocommits
    // (~7 per note) made a full rebuild fsync-bound, and a concurrent search
    // mid-rebuild saw a half-empty index. `unchecked_transaction` because the
    // connection is behind a shared reference; dropping without commit (any
    // `?` below) rolls the whole rebuild back, leaving the old index intact.
    let tx = db.unchecked_transaction()?;

    db.execute("DELETE FROM note_meta", [])?;
    db.execute("DELETE FROM notes_fts", [])?;
    db.execute("DELETE FROM links", [])?;
    // Typed properties + relations are per-note replaced by `index_note`, but a
    // note that vanished offline would strand rows a per-note pass never revisits
    // (same orphan hazard as tasks/events below) — clear them up front.
    db.execute("DELETE FROM note_properties", [])?;
    db.execute("DELETE FROM note_relations", [])?;
    // Tasks and own (note-derived) events are rebuilt per-note by `index_note`
    // below, but — unlike the tables above — they were historically never cleared
    // up front. Rows for a note that vanished while the app wasn't watching
    // (offline delete/move, external dedup) then lingered as orphans that even a
    // full reindex couldn't prune, surfacing later as "Note not found" when the
    // ghost task was toggled/opened. Clear them here so the rebuild is truly full.
    // Remote calendar events (source_id != 'local') are NOT note-derived — and a
    // refreshing source clears those itself — so leave them untouched.
    db.execute("DELETE FROM tasks", [])?;
    db.execute("DELETE FROM events WHERE source_id = 'local'", [])?;

    let notes = vault_fs::list_notes(vault);
    for summary in &notes {
        let abs = vault.join(&summary.path);
        // Cloud-only placeholders (OneDrive/iCloud "online only") are indexed
        // from metadata alone — reading them would block on a network download.
        // Their body/tasks/links get indexed on the next reindex after the file
        // is materialized locally.
        let content = match std::fs::metadata(&abs) {
            Ok(meta) if vault_fs::is_cloud_placeholder(&meta) => String::new(),
            _ => match std::fs::read_to_string(&abs) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("could not read {}: {e}", summary.path);
                    continue;
                }
            },
        };
        if let Err(e) = index_note(db, summary, &content) {
            log::warn!("failed to index {}: {e}", summary.path);
        }
    }

    // Relations resolve to a target's PATH, so per-note resolution during the
    // loop above misses any target indexed after its source. Re-resolve the
    // whole `note_relations` table now that every note is in `note_meta`.
    crate::index::properties::resolve_all_relations(db)?;

    tx.commit()?;
    log::info!("indexed {} notes", notes.len());
    Ok(())
}

/// Upsert a single note into `note_meta`, the FTS index, and the link graph.
pub fn index_note(db: &Connection, summary: &NoteSummary, content: &str) -> CoreResult<()> {
    let tags_json = serde_json::to_string(&summary.tags).unwrap_or_else(|_| "[]".to_string());
    let aliases_json = serde_json::to_string(&summary.aliases).unwrap_or_else(|_| "[]".to_string());
    let (fm, body) = frontmatter::parse_frontmatter(content);

    db.execute(
        "INSERT INTO note_meta (path, title, folder, tags, aliases, created, modified, size, word_count, pinned, task_total, task_completed, cloud_only)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(path) DO UPDATE SET
            title=excluded.title, folder=excluded.folder, tags=excluded.tags,
            aliases=excluded.aliases,
            created=excluded.created, modified=excluded.modified, size=excluded.size,
            word_count=excluded.word_count, pinned=excluded.pinned,
            task_total=excluded.task_total, task_completed=excluded.task_completed,
            cloud_only=excluded.cloud_only",
        params![
            summary.path,
            summary.title,
            summary.folder,
            tags_json,
            aliases_json,
            summary.created,
            summary.modified,
            content.len() as i64,
            summary.word_count as i64,
            summary.pinned as i32,
            summary.task_total as i64,
            summary.task_completed as i64,
            summary.cloud_only as i32,
        ],
    )?;

    // FTS5 has no upsert — delete then insert.
    db.execute(
        "DELETE FROM notes_fts WHERE path = ?1",
        params![summary.path],
    )?;
    db.execute(
        "INSERT INTO notes_fts (title, content, tags, path) VALUES (?1, ?2, ?3, ?4)",
        params![summary.title, body, tags_json, summary.path],
    )?;

    // Inline markdown checkbox tasks.
    let tasks = crate::tasks::index::extract_tasks(content, &summary.path);
    crate::tasks::index::index_tasks(db, &summary.path, &tasks)?;

    // Outgoing wiki-links.
    let targets = links::extract_wiki_links(&body);
    links::index_links(db, &summary.path, &targets)?;

    // Typed frontmatter properties + relations (query-engine foundation).
    let props = frontmatter::properties_from_extra(&fm.extra);
    crate::index::properties::index_properties(db, &summary.path, &props)?;

    // Calendar event, if the note's frontmatter declares one.
    let event = crate::index::events::event_from_note(&fm.extra, &summary.title, &summary.path);
    crate::index::events::index_event(db, event.as_ref(), &summary.path)?;

    Ok(())
}

/// Remove a note from all indexes.
pub fn remove_note(db: &Connection, path: &str) -> CoreResult<()> {
    db.execute("DELETE FROM note_meta WHERE path = ?1", params![path])?;
    db.execute("DELETE FROM notes_fts WHERE path = ?1", params![path])?;
    db.execute("DELETE FROM tasks WHERE source_note = ?1", params![path])?;
    db.execute("DELETE FROM links WHERE source_path = ?1", params![path])?;
    crate::index::properties::remove_properties(db, path)?;
    db.execute("DELETE FROM events WHERE note_path = ?1", params![path])?;
    // Drop the semantic vector too (table owned by `index::vectors`), so a
    // deleted/renamed note doesn't strand a vector that could surface in
    // "related notes" with a dangling path.
    crate::index::vectors::remove_vector(db, path)?;
    Ok(())
}

/// Escape SQL LIKE wildcards (`%`, `_`) and the escape character itself so a
/// user-typed value matches literally under an `ESCAPE '\\'` clause.
pub(crate) fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// FTS5 search with snippets and optional folder/tag filters.
pub fn search(
    db: &Connection,
    query: &str,
    folder: Option<&str>,
    tag: Option<&str>,
) -> CoreResult<Vec<SearchResult>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Bind the quoted phrase as a value — user input is never interpolated
    // into the SQL text (a stray apostrophe would be a syntax error), matching
    // the pattern in `links::unlinked_mentions`.
    let fts_query = format!("\"{}\"", query.replace('"', "\"\""));

    let mut sql = String::from(
        "SELECT f.path, f.title, snippet(notes_fts, 1, '<mark>', '</mark>', '...', 40) as snippet,
                rank
         FROM notes_fts f",
    );

    let mut conditions = vec!["notes_fts MATCH ?1".to_string()];
    let mut binds: Vec<String> = vec![fts_query];

    if let Some(folder_filter) = folder {
        binds.push(format!("{}%", escape_like(folder_filter)));
        conditions.push(format!("f.path LIKE ?{} ESCAPE '\\'", binds.len()));
    }
    if let Some(tag_filter) = tag {
        // Anchored on both quotes so the tag matches exactly within the stored
        // JSON array — `work` must not also match `workout`.
        binds.push(format!("%\"{}\"%", escape_like(tag_filter)));
        conditions.push(format!("f.tags LIKE ?{} ESCAPE '\\'", binds.len()));
    }

    sql.push_str(" WHERE ");
    sql.push_str(&conditions.join(" AND "));
    sql.push_str(" ORDER BY rank LIMIT 50");

    let mut stmt = db.prepare(&sql)?;
    let results = stmt
        .query_map(rusqlite::params_from_iter(binds.iter()), |row| {
            Ok(SearchResult {
                path: row.get(0)?,
                title: row.get(1)?,
                snippet: row.get(2)?,
                score: row.get::<_, f64>(3)?.abs(),
            })
        })?
        .filter_map(|r| crate::index::ok_row_or_warn("notes_fts", r))
        .collect();

    Ok(results)
}

/// Quick fuzzy search by filename/title for the quick-switcher.
pub fn quick_search(db: &Connection, query: &str) -> CoreResult<Vec<NoteSummary>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let pattern = format!("%{}%", escape_like(query));

    let mut stmt = db.prepare(
        "SELECT path, title, folder, tags, created, modified, pinned, word_count, task_total, task_completed, cloud_only, aliases
         FROM note_meta
         WHERE title LIKE ?1 ESCAPE '\\' OR path LIKE ?1 ESCAPE '\\' OR aliases LIKE ?1 ESCAPE '\\'
         ORDER BY modified DESC
         LIMIT 20",
    )?;

    crate::index::rows_to_summaries(&mut stmt, params![pattern])
}

/// All distinct note tags with the number of notes carrying each, sorted by
/// count (descending) then tag (ascending, case-insensitive). Tags are stored as
/// a JSON array per `note_meta` row, so aggregation happens in Rust rather than
/// via SQL `GROUP BY` (which would conflate e.g. `work` and `work-trip`).
pub fn list_tags(db: &Connection) -> CoreResult<Vec<TagCount>> {
    let mut stmt = db.prepare("SELECT tags FROM note_meta")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;

    let mut counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for row in rows.filter_map(|r| crate::index::ok_row_or_warn("note_meta", r)) {
        let tags: Vec<String> = serde_json::from_str(&row).unwrap_or_default();
        for tag in tags {
            *counts.entry(tag).or_insert(0) += 1;
        }
    }

    let mut out: Vec<TagCount> = counts
        .into_iter()
        .map(|(tag, count)| TagCount { tag, count })
        .collect();
    out.sort_by(|a, b| {
        b.count
            .cmp(&a.count)
            .then_with(|| a.tag.to_lowercase().cmp(&b.tag.to_lowercase()))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema;

    fn mem_db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let db = schema::open_db(&dir.path().join("notes.db")).unwrap();
        (dir, db)
    }

    fn summary(path: &str, title: &str) -> NoteSummary {
        NoteSummary {
            path: path.to_string(),
            title: title.to_string(),
            folder: String::new(),
            tags: vec![],
            aliases: vec![],
            created: String::new(),
            modified: String::new(),
            pinned: false,
            word_count: 0,
            task_total: 0,
            task_completed: 0,
            cloud_only: false,
        }
    }

    #[test]
    fn index_and_full_text_search() {
        let (_tmp, db) = mem_db();
        index_note(
            &db,
            &summary("notes/alpha.md", "Alpha"),
            "---\ntitle: Alpha\n---\nThe quick brown fox jumps.",
        )
        .unwrap();
        index_note(
            &db,
            &summary("notes/beta.md", "Beta"),
            "---\ntitle: Beta\n---\nA lazy dog sleeps.",
        )
        .unwrap();

        let hits = search(&db, "fox", None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "notes/alpha.md");

        let quick = quick_search(&db, "bet").unwrap();
        assert_eq!(quick.len(), 1);
        assert_eq!(quick[0].title, "Beta");
    }

    #[test]
    fn cloud_only_flag_round_trips_through_the_index() {
        let (_tmp, db) = mem_db();
        let mut s = summary("a.md", "A");
        s.cloud_only = true;
        index_note(&db, &s, "").unwrap();
        index_note(&db, &summary("b.md", "B"), "hello").unwrap();

        let all = crate::index::list_summaries(&db).unwrap();
        assert!(all.iter().find(|n| n.path == "a.md").unwrap().cloud_only);
        assert!(!all.iter().find(|n| n.path == "b.md").unwrap().cloud_only);
    }

    #[test]
    fn remove_note_clears_index() {
        let (_tmp, db) = mem_db();
        index_note(&db, &summary("a.md", "A"), "hello world").unwrap();
        // Stored semantic chunks must be cleared alongside the other indexes.
        let chunk = crate::index::vectors::Chunk {
            ord: 0,
            char_start: 0,
            char_end: 0,
            text: String::new(),
        };
        crate::index::vectors::upsert_note_chunks(
            &db,
            "a.md",
            "m",
            "h",
            &[(chunk, vec![1.0, 2.0])],
        )
        .unwrap();
        remove_note(&db, "a.md").unwrap();
        assert!(search(&db, "hello", None, None).unwrap().is_empty());
        assert_eq!(
            crate::index::vectors::count_notes_for_model(&db, "m").unwrap(),
            0
        );
    }

    #[test]
    fn build_index_prunes_orphan_tasks_and_local_events() {
        // A note that vanishes from disk while unobserved (offline delete, external
        // dedup) must not strand task/event rows that a later full reindex can't
        // reach — those orphans surfaced as "Note not found" when toggled/opened.
        let dir = std::env::temp_dir().join(format!("novalis-vault-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = schema::open_db(&dir.join("notes.db")).unwrap();

        let note = dir.join("ghost.md");
        std::fs::write(
            &note,
            "---\ntitle: Ghost\ntype: event\ndate: 2026-01-01\n---\n- [ ] haunt the index\n",
        )
        .unwrap();

        let count = |table: &str, col: &str| -> i64 {
            db.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE {col} = 'ghost.md'"),
                [],
                |r| r.get(0),
            )
            .unwrap()
        };

        build_index(&db, &dir).unwrap();
        assert_eq!(count("tasks", "source_note"), 1, "task should index");
        assert_eq!(count("events", "note_path"), 1, "local event should index");

        // The file disappears without the app observing the change.
        std::fs::remove_file(&note).unwrap();

        // A full reindex must leave NO orphan rows behind.
        build_index(&db, &dir).unwrap();
        assert_eq!(
            count("tasks", "source_note"),
            0,
            "orphan task survived reindex"
        );
        assert_eq!(
            count("events", "note_path"),
            0,
            "orphan local event survived reindex"
        );
    }

    #[test]
    fn list_tags_aggregates_and_sorts() {
        let (_tmp, db) = mem_db();
        let mut a = summary("a.md", "A");
        a.tags = vec!["work".into(), "idea".into()];
        let mut b = summary("b.md", "B");
        b.tags = vec!["work".into()];
        index_note(&db, &a, "body").unwrap();
        index_note(&db, &b, "body").unwrap();

        let tags = list_tags(&db).unwrap();
        // count DESC, then tag ASC
        assert_eq!(tags.len(), 2);
        assert_eq!((tags[0].tag.as_str(), tags[0].count), ("work", 2));
        assert_eq!((tags[1].tag.as_str(), tags[1].count), ("idea", 1));
    }

    #[test]
    fn list_tags_empty_vault_is_empty() {
        let (_tmp, db) = mem_db();
        assert!(list_tags(&db).unwrap().is_empty());
    }

    #[test]
    fn search_tag_filter_is_exact_not_prefix() {
        let (_tmp, db) = mem_db();
        let mut a = summary("a.md", "Alpha");
        a.tags = vec!["work".into()];
        let mut b = summary("b.md", "Beta");
        b.tags = vec!["workout".into()];
        index_note(&db, &a, "shared body text").unwrap();
        index_note(&db, &b, "shared body text").unwrap();

        let hits = search(&db, "shared", None, Some("work")).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "a.md");
    }

    #[test]
    fn search_handles_hostile_query_input() {
        let (_tmp, db) = mem_db();
        index_note(
            &db,
            &summary("a.md", "A"),
            "---\ntitle: A\n---\nwe don't panic at 100% or a_b or \"quoted\" text",
        )
        .unwrap();
        index_note(
            &db,
            &summary("b.md", "B"),
            "---\ntitle: B\n---\nplain other prose",
        )
        .unwrap();

        // An apostrophe must not be a SQL syntax error (it used to be — the
        // query was interpolated into the MATCH literal).
        let hits = search(&db, "don't", None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "a.md");
        // None of these may error either.
        for q in ["100%", "a_b", "\"quoted\"", "50% off", "it's"] {
            search(&db, q, None, None).unwrap();
        }
        // Filter values with quotes/LIKE metacharacters bind as literals.
        assert!(search(&db, "prose", Some("100%"), None).unwrap().is_empty());
        assert!(search(&db, "prose", None, Some("a_b")).unwrap().is_empty());
        assert!(search(&db, "prose", None, Some("it's")).unwrap().is_empty());
    }

    #[test]
    fn quick_search_escapes_like_wildcards() {
        let (_tmp, db) = mem_db();
        index_note(&db, &summary("pct.md", "100% done"), "x").unwrap();
        index_note(&db, &summary("num.md", "1000 things"), "x").unwrap();
        index_note(&db, &summary("und.md", "a_b"), "x").unwrap();
        index_note(&db, &summary("mid.md", "aXb"), "x").unwrap();

        // `%` matches literally, not as a LIKE wildcard...
        let pct = quick_search(&db, "100%").unwrap();
        assert_eq!(
            pct.len(),
            1,
            "got: {:?}",
            pct.iter().map(|n| &n.path).collect::<Vec<_>>()
        );
        assert_eq!(pct[0].path, "pct.md");
        // ...and `_` doesn't match arbitrary single characters.
        let und = quick_search(&db, "a_b").unwrap();
        assert_eq!(
            und.len(),
            1,
            "got: {:?}",
            und.iter().map(|n| &n.path).collect::<Vec<_>>()
        );
        assert_eq!(und[0].path, "und.md");
        // A backslash in the query is literal too, not the escape character.
        assert!(quick_search(&db, "back\\slash").unwrap().is_empty());
    }

    #[test]
    fn quick_search_matches_aliases_and_round_trips_them() {
        let (_tmp, db) = mem_db();
        let mut s = summary("widget.md", "Widget Co");
        s.aliases = vec!["Globex".to_string()];
        index_note(&db, &s, "body").unwrap();

        // Query matches only the alias (not title/path), proving alias search.
        let hits = quick_search(&db, "globex").unwrap();
        assert!(hits.iter().any(|h| h.path == "widget.md"));
        // And the alias column round-trips through the SELECT/row mapping.
        assert_eq!(hits[0].aliases, vec!["Globex".to_string()]);
    }
}
