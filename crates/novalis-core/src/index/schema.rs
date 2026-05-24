//! Index database schema and versioning.
//!
//! The index is a pure cache: on a schema-version mismatch we drop and recreate
//! the tables, then the caller rebuilds from the vault. This means schema
//! changes never require migrations — bump [`SCHEMA_VERSION`] and the index
//! rebuilds itself on next open.

use std::path::Path;

use rusqlite::Connection;

use crate::error::CoreResult;

/// Bump this whenever the table layout below changes.
pub const SCHEMA_VERSION: i64 = 1;

/// Open (or create) the index database at `path`, ensuring the schema matches
/// [`SCHEMA_VERSION`]. On mismatch the tables are dropped and recreated.
pub fn open_db(path: &Path) -> CoreResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;

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

    Ok(conn)
}

fn drop_tables(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS note_meta;
         DROP TABLE IF EXISTS notes_fts;
         DROP TABLE IF EXISTS tasks;
         DROP TABLE IF EXISTS links;",
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
            task_completed INTEGER DEFAULT 0
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
            parent_id TEXT
        );

        CREATE TABLE IF NOT EXISTS links (
            source_path TEXT NOT NULL,
            target_title TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_title);
        CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_path);",
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
