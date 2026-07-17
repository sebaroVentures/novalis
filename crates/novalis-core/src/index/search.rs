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
    // Block index + reference graph are per-note replaced by `index_note`, but a
    // note that vanished offline would strand rows a per-note pass never revisits
    // — clear them up front (same orphan hazard as properties/relations above).
    db.execute("DELETE FROM block_index", [])?;
    db.execute("DELETE FROM block_refs", [])?;
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
        let meta = std::fs::metadata(&abs);
        let content = match &meta {
            Ok(m) if vault_fs::is_cloud_placeholder(m) => String::new(),
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
            continue;
        }
        // Record the on-disk mtime so a later incremental scan can skip this
        // note when it hasn't changed.
        if let Some(ms) = meta.ok().as_ref().and_then(vault_fs::file_mtime_ms) {
            let _ = db.execute(
                "UPDATE note_meta SET mtime = ?1 WHERE path = ?2",
                params![ms, summary.path],
            );
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

    // Stable block ids (` ^id` markers) and the outgoing `((^id))` reference
    // graph — both rebuilt per-note so they never drift from the Markdown.
    let blocks = crate::index::blocks::extract_block_ids(&body);
    crate::index::blocks::index_blocks(db, &summary.path, &blocks)?;
    let block_refs = crate::index::blocks::extract_block_refs(&body);
    crate::index::blocks::index_block_refs(db, &summary.path, &block_refs)?;

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
    crate::index::blocks::remove_blocks(db, path)?;
    crate::index::properties::remove_properties(db, path)?;
    db.execute("DELETE FROM events WHERE note_path = ?1", params![path])?;
    // Drop the semantic vector too (table owned by `index::vectors`), so a
    // deleted/renamed note doesn't strand a vector that could surface in
    // "related notes" with a dangling path.
    crate::index::vectors::remove_vector(db, path)?;
    Ok(())
}

/// Record a note's on-disk modification time (milliseconds since the Unix
/// epoch) after it has been indexed, so the incremental startup scan can skip
/// it when unchanged. A no-op if the note isn't in `note_meta`.
pub fn stamp_mtime(db: &Connection, path: &str, mtime_ms: i64) -> CoreResult<()> {
    db.execute(
        "UPDATE note_meta SET mtime = ?1 WHERE path = ?2",
        params![mtime_ms, path],
    )?;
    Ok(())
}

/// Incrementally reconcile the index with the vault: stat every note (never
/// reading a body up front) and reindex only those that are new or whose on-disk
/// mtime differs from the last indexed value, then drop notes that vanished —
/// all in one transaction. Returns the number of notes reindexed.
///
/// Conservative by contract (a missed change is a correctness bug): a note that
/// is new, was never stamped (`mtime == 0`), or whose mtime can't be read is
/// treated as changed and reindexed. A steady-state reopen of an unchanged vault
/// therefore costs only a directory walk + stats — no body reads, no FTS
/// re-tokenization, no cloud hydration — while a full rebuild ([`build_index`])
/// is reserved for schema bumps and the explicit "rebuild index" path.
pub fn incremental_index(db: &Connection, vault: &Path) -> CoreResult<usize> {
    log::info!("incremental index scan for vault: {}", vault.display());

    // One transaction like `build_index`: a concurrent search never sees a
    // half-updated index, and any `?` below rolls the whole scan back.
    let tx = db.unchecked_transaction()?;

    // What the index already knows: path -> last-stamped mtime.
    let indexed: std::collections::HashMap<String, i64> = {
        let mut stmt = db.prepare("SELECT path, mtime FROM note_meta")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.filter_map(|r| crate::index::ok_row_or_warn("note_meta", r))
            .collect()
    };

    let mut seen = std::collections::HashSet::new();
    let mut reindexed = 0usize;
    let mut dirty = false;

    for (rel, meta) in vault_fs::walk_note_metadata(vault) {
        seen.insert(rel.clone());
        let file_mtime = vault_fs::file_mtime_ms(&meta);
        // Unchanged only when the file has a readable mtime that exactly matches
        // a previously-stamped (non-zero) value. Everything else reindexes.
        let unchanged = match (indexed.get(&rel), file_mtime) {
            (Some(&stored), Some(cur)) => stored != 0 && stored == cur,
            _ => false,
        };
        if unchanged {
            continue;
        }

        let summary = match vault_fs::build_summary(vault, &rel) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("skipping {rel}: {e}");
                continue;
            }
        };
        // Mirror `build_index`: a cloud-only placeholder is indexed from its
        // metadata with an empty body (never hydrated over the network).
        let content = if vault_fs::is_cloud_placeholder(&meta) {
            String::new()
        } else {
            match std::fs::read_to_string(vault.join(&rel)) {
                Ok(c) => c,
                Err(e) => {
                    log::warn!("could not read {rel}: {e}");
                    continue;
                }
            }
        };
        if let Err(e) = index_note(db, &summary, &content) {
            log::warn!("failed to index {rel}: {e}");
            continue;
        }
        if let Some(ms) = file_mtime {
            let _ = db.execute(
                "UPDATE note_meta SET mtime = ?1 WHERE path = ?2",
                params![ms, rel],
            );
        }
        reindexed += 1;
        dirty = true;
    }

    // Notes that vanished from disk while unobserved (offline delete/move): drop
    // them and their derived rows, same cleanup `build_index` guarantees.
    for path in indexed.keys() {
        if !seen.contains(path) {
            remove_note(db, path)?;
            dirty = true;
        }
    }

    // Relations resolve to a target's PATH, so a newly-added note may be the
    // target of an older one. Re-resolve the whole table (DB-only) — but only if
    // anything actually changed, keeping an unchanged reopen free of extra work.
    if dirty {
        crate::index::properties::resolve_all_relations(db)?;
    }

    tx.commit()?;
    log::info!("incremental scan reindexed {reindexed} notes");
    Ok(reindexed)
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

    // ── Incremental scan + list parity ───────────────────────────────────────

    /// A fresh vault dir plus an index db. The vault is a `vault/` subdir of a
    /// tempdir (NOT the tempdir itself: `tempfile` names it `.tmpXXXX`, and a
    /// hidden WalkDir root would be pruned) and the db lives outside it.
    fn scan_ctx() -> (tempfile::TempDir, std::path::PathBuf, Connection) {
        let base = tempfile::tempdir().unwrap();
        let vault = base.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        let db = schema::open_db(&base.path().join("notes.db")).unwrap();
        (base, vault, db)
    }

    fn indexed_paths(db: &Connection) -> Vec<String> {
        let mut p: Vec<String> = crate::index::list_summaries(db)
            .unwrap()
            .into_iter()
            .map(|s| s.path)
            .collect();
        p.sort();
        p
    }

    #[test]
    fn list_summaries_matches_list_notes_after_build_index() {
        // Parity guard for the `list_notes` command now served from the index:
        // every `NoteSummary` field must equal what a from-disk walk produces.
        let (_base, vault, db) = scan_ctx();
        std::fs::create_dir_all(vault.join("sub")).unwrap();
        std::fs::write(
            vault.join("alpha.md"),
            "---\ntitle: Alpha\ntags:\n  - work\naliases:\n  - A1\npinned: true\n---\n\n# Alpha\n\nbody with #urgent\n\n- [ ] one\n- [x] two\n",
        )
        .unwrap();
        std::fs::write(
            vault.join("sub/beta.md"),
            "plain note, no frontmatter, several words here\n",
        )
        .unwrap();

        build_index(&db, &vault).unwrap();

        // NoteSummary has no PartialEq (wire type) — compare every field via a
        // tuple, sorted by path so directory-walk vs SELECT ordering is moot.
        let fields = |s: &NoteSummary| {
            (
                s.path.clone(),
                s.title.clone(),
                s.folder.clone(),
                s.tags.clone(),
                s.aliases.clone(),
                s.created.clone(),
                s.modified.clone(),
                s.pinned,
                s.word_count,
                s.task_total,
                s.task_completed,
                s.cloud_only,
            )
        };
        let mut from_index: Vec<_> = crate::index::list_summaries(&db)
            .unwrap()
            .iter()
            .map(fields)
            .collect();
        let mut from_disk: Vec<_> = vault_fs::list_notes(&vault).iter().map(fields).collect();
        from_index.sort();
        from_disk.sort();
        assert_eq!(
            from_index, from_disk,
            "index-served summaries must match a from-disk walk field-for-field"
        );
    }

    #[test]
    fn incremental_scan_skips_unchanged_notes() {
        let (_base, vault, db) = scan_ctx();
        std::fs::write(vault.join("a.md"), "---\ntitle: A\n---\nhello").unwrap();
        std::fs::write(vault.join("b.md"), "---\ntitle: B\n---\nworld").unwrap();
        build_index(&db, &vault).unwrap();

        // Nothing touched on disk → nothing reindexed, index unchanged.
        let n = incremental_index(&db, &vault).unwrap();
        assert_eq!(n, 0, "unchanged vault must reindex nothing");
        assert_eq!(indexed_paths(&db), ["a.md", "b.md"]);
        assert_eq!(search(&db, "hello", None, None).unwrap().len(), 1);
    }

    #[test]
    fn incremental_scan_indexes_a_new_note() {
        let (_base, vault, db) = scan_ctx();
        std::fs::write(vault.join("a.md"), "---\ntitle: A\n---\nhello").unwrap();
        build_index(&db, &vault).unwrap();

        // A note that appeared while unobserved is picked up (only it is reindexed).
        std::fs::write(vault.join("new.md"), "---\ntitle: New\n---\nkingfisher").unwrap();
        let n = incremental_index(&db, &vault).unwrap();
        assert_eq!(n, 1, "only the new note should reindex");
        assert_eq!(indexed_paths(&db), ["a.md", "new.md"]);
        assert_eq!(
            search(&db, "kingfisher", None, None).unwrap()[0].path,
            "new.md"
        );
    }

    #[test]
    fn incremental_scan_reindexes_a_changed_note() {
        let (_base, vault, db) = scan_ctx();
        std::fs::write(vault.join("a.md"), "---\ntitle: A\n---\nosprey").unwrap();
        build_index(&db, &vault).unwrap();
        assert_eq!(search(&db, "osprey", None, None).unwrap().len(), 1);

        // Overwrite the body, then force the stamped mtime stale so the scan
        // detects the change deterministically (filesystem mtime resolution can
        // otherwise collapse a same-tick rewrite — the scan's `stored != current`
        // rule is what we exercise here).
        std::fs::write(vault.join("a.md"), "---\ntitle: A\n---\nperegrine").unwrap();
        db.execute("UPDATE note_meta SET mtime = 1 WHERE path = 'a.md'", [])
            .unwrap();

        let n = incremental_index(&db, &vault).unwrap();
        assert_eq!(n, 1, "the changed note should reindex");
        assert!(
            search(&db, "osprey", None, None).unwrap().is_empty(),
            "stale content must be gone from the FTS index"
        );
        assert_eq!(search(&db, "peregrine", None, None).unwrap().len(), 1);
    }

    #[test]
    fn incremental_scan_removes_a_deleted_note() {
        let (_base, vault, db) = scan_ctx();
        std::fs::write(vault.join("a.md"), "---\ntitle: A\n---\nhello").unwrap();
        std::fs::write(vault.join("b.md"), "---\ntitle: B\n---\nworld").unwrap();
        build_index(&db, &vault).unwrap();

        // A file removed while unobserved must leave the index on the next scan.
        std::fs::remove_file(vault.join("b.md")).unwrap();
        let n = incremental_index(&db, &vault).unwrap();
        assert_eq!(n, 0, "a pure deletion reindexes nothing");
        assert_eq!(indexed_paths(&db), ["a.md"]);
        assert!(search(&db, "world", None, None).unwrap().is_empty());
    }

    #[test]
    fn incremental_scan_from_empty_index_indexes_everything() {
        // After a SCHEMA_VERSION bump `open_db` drops the tables, so the first
        // scan sees an empty index and must reindex every note (full rebuild via
        // the incremental path).
        let (_base, vault, db) = scan_ctx();
        std::fs::write(vault.join("a.md"), "---\ntitle: A\n---\nhello").unwrap();
        std::fs::write(vault.join("b.md"), "---\ntitle: B\n---\nworld").unwrap();

        let n = incremental_index(&db, &vault).unwrap();
        assert_eq!(n, 2, "an empty index reindexes all notes");
        assert_eq!(indexed_paths(&db), ["a.md", "b.md"]);

        // And a follow-up scan now skips both (mtime stamped on the first pass).
        assert_eq!(incremental_index(&db, &vault).unwrap(), 0);
    }

    #[test]
    fn incremental_scan_matches_full_rebuild_output() {
        // The incremental path and a full rebuild must land the index in the same
        // observable state for a given vault.
        let build_vault = |vault: &std::path::Path| {
            std::fs::create_dir_all(vault.join("sub")).unwrap();
            std::fs::write(
                vault.join("a.md"),
                "---\ntitle: A\ntags:\n  - x\n---\n# A\n\nalpha [[B]]\n- [ ] t1\n",
            )
            .unwrap();
            std::fs::write(vault.join("sub/b.md"), "---\ntitle: B\n---\nbeta body").unwrap();
        };

        // Non-hidden `vault/` subdirs (a `.tmpXXXX` WalkDir root would be pruned).
        let full_base = tempfile::tempdir().unwrap();
        let full_vault = full_base.path().join("vault");
        std::fs::create_dir_all(&full_vault).unwrap();
        build_vault(&full_vault);
        let full_db = schema::open_db(&full_base.path().join("notes.db")).unwrap();
        build_index(&full_db, &full_vault).unwrap();

        let inc_base = tempfile::tempdir().unwrap();
        let inc_vault = inc_base.path().join("vault");
        std::fs::create_dir_all(&inc_vault).unwrap();
        build_vault(&inc_vault);
        let inc_db = schema::open_db(&inc_base.path().join("notes.db")).unwrap();
        incremental_index(&inc_db, &inc_vault).unwrap();

        // Same summaries (order-independent) and same FTS hits.
        assert_eq!(indexed_paths(&full_db), indexed_paths(&inc_db));
        for q in ["alpha", "beta", "A", "B"] {
            let mut f: Vec<String> = search(&full_db, q, None, None)
                .unwrap()
                .into_iter()
                .map(|r| r.path)
                .collect();
            let mut i: Vec<String> = search(&inc_db, q, None, None)
                .unwrap()
                .into_iter()
                .map(|r| r.path)
                .collect();
            f.sort();
            i.sort();
            assert_eq!(f, i, "FTS results diverged for query {q:?}");
        }
    }

    /// Timing harness for the second-open win. Ignored by default (allocation
    /// heavy, timing-dependent); run with:
    ///   cargo test -p novalis-core second_open_incremental_vs_full -- --ignored --nocapture
    #[test]
    #[ignore]
    fn second_open_incremental_vs_full() {
        use std::time::Instant;
        const N: usize = 2000;

        let base = tempfile::tempdir().unwrap();
        let vault = base.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        for i in 0..N {
            std::fs::write(
                vault.join(format!("note-{i:04}.md")),
                format!(
                    "---\ntitle: Note {i}\ntags:\n  - t{}\n---\n# Note {i}\n\nThe quick brown fox number {i} jumps over [[Note {}]].\n\n- [ ] task {i}\n",
                    i % 10,
                    (i + 1) % N,
                ),
            )
            .unwrap();
        }
        let db = schema::open_db(&base.path().join("notes.db")).unwrap();

        // First open populates + stamps mtime.
        build_index(&db, &vault).unwrap();

        // "Second open" — nothing changed on disk.
        let t0 = Instant::now();
        build_index(&db, &vault).unwrap();
        let full = t0.elapsed();

        let t1 = Instant::now();
        let reindexed = incremental_index(&db, &vault).unwrap();
        let inc = t1.elapsed();

        eprintln!(
            "second open of {N} unchanged notes: full rebuild = {full:?}, incremental = {inc:?} (reindexed {reindexed})"
        );
        assert_eq!(reindexed, 0, "an unchanged reopen must reindex nothing");
    }
}
