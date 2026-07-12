//! Index database schema and versioning.
//!
//! The index is a pure cache: on a schema-version mismatch we drop and recreate
//! the tables, then the caller rebuilds from the vault. This means schema
//! changes never require migrations — bump [`SCHEMA_VERSION`] and the index
//! rebuilds itself on next open.

use std::path::Path;

use rusqlite::Connection;

use crate::error::CoreResult;

/// Bump this whenever the table layout below changes — or when a column that
/// already exists starts being populated (v7: `note_meta.aliases` is now written
/// and queried; v8: typed `note_properties` + `note_relations` are indexed;
/// v9: `block_index` + `block_refs` for first-class block references), so
/// existing caches rebuild and backfill it.
pub const SCHEMA_VERSION: i64 = 9;

/// Open (or create) the index database at `path`, ensuring the schema matches
/// [`SCHEMA_VERSION`]. On mismatch the tables are dropped and recreated.
pub fn open_db(path: &Path) -> CoreResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    // Wait (rather than fail with "database is locked") when the write lock is
    // briefly held — e.g. a background reindex/WAL checkpoint, or a second app
    // instance still holding the same notes.db during a restart. WAL gives
    // concurrent readers + one writer; busy_timeout covers the write-lock
    // contention WAL alone doesn't (SQLITE_BUSY is returned immediately without
    // it). NORMAL synchronous is the recommended, durable-enough setting under
    // WAL and cuts fsyncs on the hot write path.
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch("PRAGMA synchronous=NORMAL;")?;

    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current != SCHEMA_VERSION {
        if current != 0 {
            log::info!("index schema {current} != {SCHEMA_VERSION}; rebuilding");
        }
        drop_tables(&conn)?;
        create_tables(&conn)?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    } else {
        create_tables(&conn)?;
    }

    // Semantic vectors are deliberately NOT part of the disposable cache above:
    // they cost network round-trips + provider tokens to recompute, so a
    // `SCHEMA_VERSION` bump (which drops the free FTS/meta caches) must leave
    // them intact. They live in `note_chunks` (one row per note chunk), are
    // absent from `drop_tables`, and carry their own layout version — see
    // `index::vectors`.
    crate::index::vectors::ensure_schema(&conn)?;

    Ok(conn)
}

fn drop_tables(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS note_meta;
         DROP TABLE IF EXISTS notes_fts;
         DROP TABLE IF EXISTS tasks;
         DROP TABLE IF EXISTS links;
         DROP TABLE IF EXISTS note_properties;
         DROP TABLE IF EXISTS note_relations;
         DROP TABLE IF EXISTS block_index;
         DROP TABLE IF EXISTS block_refs;
         DROP TABLE IF EXISTS events;",
    )?;
    Ok(())
}

fn create_tables(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS note_meta (
            path TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            folder TEXT NOT NULL,
            tags TEXT DEFAULT '[]',
            aliases TEXT DEFAULT '[]',
            created TEXT NOT NULL,
            modified TEXT NOT NULL,
            size INTEGER NOT NULL DEFAULT 0,
            word_count INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER DEFAULT 0,
            task_total INTEGER DEFAULT 0,
            task_completed INTEGER DEFAULT 0,
            cloud_only INTEGER DEFAULT 0
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
            title, content, tags, path,
            tokenize='unicode61'
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            completed INTEGER NOT NULL DEFAULT 0,
            priority TEXT,
            due_date TEXT,
            status TEXT,
            source_note TEXT NOT NULL,
            source_line INTEGER NOT NULL,
            tags TEXT DEFAULT '[]',
            repeat TEXT,
            parent_id TEXT,
            note_title TEXT NOT NULL DEFAULT '',
            heading TEXT,
            project TEXT,
            epic TEXT,
            start_date TEXT,
            remind TEXT
        );

        CREATE TABLE IF NOT EXISTS links (
            source_path TEXT NOT NULL,
            target_title TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_title);
        CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_path);

        CREATE TABLE IF NOT EXISTS note_properties (
            path TEXT NOT NULL,
            key TEXT NOT NULL,
            kind TEXT NOT NULL,
            value TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_note_properties_path ON note_properties(path);
        CREATE INDEX IF NOT EXISTS idx_note_properties_key ON note_properties(key);

        CREATE TABLE IF NOT EXISTS note_relations (
            source_path TEXT NOT NULL,
            key TEXT NOT NULL,
            target_path TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_note_relations_source ON note_relations(source_path);
        CREATE INDEX IF NOT EXISTS idx_note_relations_target ON note_relations(target_path);

        CREATE TABLE IF NOT EXISTS block_index (
            note_path TEXT NOT NULL,
            block_id TEXT NOT NULL,
            char_start INTEGER NOT NULL,
            char_end INTEGER NOT NULL,
            text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_block_index_id ON block_index(block_id);
        CREATE INDEX IF NOT EXISTS idx_block_index_note ON block_index(note_path);

        CREATE TABLE IF NOT EXISTS block_refs (
            source_path TEXT NOT NULL,
            block_id TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_block_refs_id ON block_refs(block_id);
        CREATE INDEX IF NOT EXISTS idx_block_refs_source ON block_refs(source_path);

        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            source_id TEXT NOT NULL,
            title TEXT,
            start TEXT NOT NULL,
            end_at TEXT,
            all_day INTEGER DEFAULT 0,
            rrule TEXT,
            location TEXT,
            note_path TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_events_source ON events(source_id);
        CREATE INDEX IF NOT EXISTS idx_events_note ON events(note_path);",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_db_sets_schema_version_and_is_reopenable() {
        let dir = std::env::temp_dir().join(format!("novalis-db-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.db");

        let conn = open_db(&path).unwrap();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        drop(conn);

        // Reopening keeps data/tables intact (no rebuild path panics).
        let conn = open_db(&path).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM note_meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);

        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }
}
