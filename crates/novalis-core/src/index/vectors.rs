//! On-device semantic vectors: a *persistent* table of note embeddings plus
//! pure brute-force cosine similarity, powering "find related notes" and
//! semantic search.
//!
//! ## Why this table is special
//!
//! Unlike the rest of the index (note_meta/notes_fts/links/…), embeddings are
//! **expensive to recompute** — every vector costs a network round-trip and
//! provider tokens. So `note_vectors` is deliberately **NOT** part of the
//! disposable-cache contract in [`super::schema`]: it is created and versioned
//! here (via [`ensure_schema`]) and is **never dropped by
//! `schema::drop_tables`**. A `SCHEMA_VERSION` bump that rebuilds the free
//! caches therefore leaves embeddings intact. The vector layout has its own
//! marker ([`VECTORS_VERSION`] in `note_vectors_meta`); only a change to *that*
//! drops and re-creates `note_vectors` (a one-time re-embed).
//!
//! ## Embedding stays out of the write path
//!
//! [`super::search::index_note`] / [`crate::change::reindex_path`] never touch
//! this table — per-keystroke autosave must not pay a network cost. Vectors are
//! (re)computed only by an explicit, batched build (the desktop
//! `ai_build_embeddings` command). The trade-off: a note edited after it was
//! embedded is *staler* than the index until the next build; that's surfaced,
//! not hidden.

use std::collections::HashMap;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::error::CoreResult;
use crate::vault::{frontmatter, fs as vault_fs};

/// On-disk layout version for `note_vectors`. Bump only when the table's columns
/// or the vector encoding change — [`ensure_schema`] then drops + recreates the
/// table (a one-time re-embed), independent of [`super::schema::SCHEMA_VERSION`].
pub const VECTORS_VERSION: i64 = 1;

/// Max characters of a note's text fed to the embedder. Long notes are embedded
/// from their leading portion only. A middle-ground budget (~3k tokens): large
/// enough to capture most notes whole, small enough to stay well within common
/// embedding context windows (OpenAI 8k+, but some local models cap lower; the
/// server truncates the rest harmlessly). The staleness hash is computed over
/// the *full* text, so edits past the cutoff still trigger a re-embed.
pub const EMBED_CHAR_BUDGET: usize = 12_000;

/// A note that needs (re)embedding: where it lives, the hash of its full
/// embed-source (for staleness), and the (truncated) text to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbedJob {
    pub path: String,
    pub content_hash: String,
    pub text: String,
}

/// A stored vector with the metadata needed to judge freshness/compatibility.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredVector {
    pub content_hash: String,
    pub model: String,
    pub dim: usize,
    pub vec: Vec<f32>,
}

/// One similarity hit: a related note and its cosine score in `[-1, 1]`.
#[derive(Debug, Clone, PartialEq)]
pub struct ScoredNote {
    pub path: String,
    pub title: String,
    pub score: f32,
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB / no IO) — the load-bearing, unit-tested core.
// ---------------------------------------------------------------------------

/// Encode an f32 vector as little-endian bytes for BLOB storage.
pub fn encode(vec: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vec.len() * 4);
    for f in vec {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

/// Decode little-endian bytes back into an f32 vector. Returns `None` on a
/// corrupt BLOB (length not a multiple of 4) rather than panicking, so a damaged
/// row degrades to "no vector" instead of crashing a query.
pub fn decode(bytes: &[u8]) -> Option<Vec<f32>> {
    if bytes.len() % 4 != 0 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// Cosine similarity in `[-1, 1]`. Returns `0.0` (never NaN, never a panic) when
/// the dimensions differ or either vector has zero magnitude.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// The full text embedded for a note: its title and body, joined. The caller
/// passes the already-extracted title (from the index) and the frontmatter is
/// stripped from the body by [`collect_stale`]; this fn does no parsing.
pub fn embed_text(title: &str, body: &str) -> String {
    let title = title.trim();
    let body = body.trim();
    if title.is_empty() {
        body.to_string()
    } else if body.is_empty() {
        title.to_string()
    } else {
        format!("{title}\n\n{body}")
    }
}

/// Truncate to at most `max` Unicode scalar values — UTF-8-safe (never splits a
/// codepoint). Used to bound the embed request; the hash uses the full text.
pub fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// Stable content hash (SHA-256, hex) of the *full* embed text. Same text →
/// same hash; any change → a different hash, which marks the note for re-embed.
pub fn content_hash(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for b in digest {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

/// Brute-force k-nearest by cosine over `candidates`, excluding `exclude` and
/// any candidate whose dimension doesn't match `query` (a model mismatch).
/// Pure (no DB): returns the top `k` by score, descending. Ties broken by path
/// for determinism.
pub fn nearest(
    candidates: &[(String, String, Vec<f32>)],
    query: &[f32],
    k: usize,
    exclude: &str,
) -> Vec<ScoredNote> {
    let mut scored: Vec<ScoredNote> = candidates
        .iter()
        .filter(|(path, _, vec)| path != exclude && vec.len() == query.len())
        .map(|(path, title, vec)| ScoredNote {
            path: path.clone(),
            title: title.clone(),
            score: cosine(query, vec),
        })
        .collect();
    scored.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.path.cmp(&b.path))
    });
    scored.truncate(k);
    scored
}

// ---------------------------------------------------------------------------
// Schema (independent of the disposable index version).
// ---------------------------------------------------------------------------

/// Create `note_vectors` (+ its layout-version marker) if absent, and if the
/// stored [`VECTORS_VERSION`] differs, drop+recreate the table (a one-time
/// re-embed). Called from [`super::schema::open_db`] on every open; idempotent.
pub fn ensure_schema(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS note_vectors (
            path TEXT PRIMARY KEY,
            content_hash TEXT NOT NULL,
            model TEXT NOT NULL,
            dim INTEGER NOT NULL,
            vec BLOB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_note_vectors_model ON note_vectors(model);
        CREATE TABLE IF NOT EXISTS note_vectors_meta (version INTEGER NOT NULL);",
    )?;

    let current: Option<i64> = conn
        .query_row("SELECT version FROM note_vectors_meta LIMIT 1", [], |r| {
            r.get(0)
        })
        .optional()?;

    match current {
        Some(v) if v == VECTORS_VERSION => {}
        Some(_) => {
            // Layout changed: discard the (now-incompatible) vectors. They'll be
            // re-embedded on the next build. Keep this isolated from the
            // free-cache rebuild in schema::drop_tables.
            conn.execute_batch(
                "DROP TABLE IF EXISTS note_vectors;
                 CREATE TABLE note_vectors (
                    path TEXT PRIMARY KEY,
                    content_hash TEXT NOT NULL,
                    model TEXT NOT NULL,
                    dim INTEGER NOT NULL,
                    vec BLOB NOT NULL
                 );
                 CREATE INDEX idx_note_vectors_model ON note_vectors(model);",
            )?;
            conn.execute("DELETE FROM note_vectors_meta", [])?;
            conn.execute(
                "INSERT INTO note_vectors_meta (version) VALUES (?1)",
                params![VECTORS_VERSION],
            )?;
        }
        None => {
            conn.execute(
                "INSERT INTO note_vectors_meta (version) VALUES (?1)",
                params![VECTORS_VERSION],
            )?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Storage.
// ---------------------------------------------------------------------------

/// Insert or replace the vector for `path` (one row per path; a re-embed under a
/// new model overwrites the old one).
pub fn upsert_vector(
    db: &Connection,
    path: &str,
    content_hash: &str,
    model: &str,
    vec: &[f32],
) -> CoreResult<()> {
    db.execute(
        "INSERT INTO note_vectors (path, content_hash, model, dim, vec)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET
            content_hash = excluded.content_hash,
            model = excluded.model,
            dim = excluded.dim,
            vec = excluded.vec",
        params![path, content_hash, model, vec.len() as i64, encode(vec)],
    )?;
    Ok(())
}

/// The stored vector for `path`, if any (and if its BLOB decodes cleanly).
pub fn get_vector(db: &Connection, path: &str) -> CoreResult<Option<StoredVector>> {
    let row = db
        .query_row(
            "SELECT content_hash, model, dim, vec FROM note_vectors WHERE path = ?1",
            params![path],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? as usize,
                    r.get::<_, Vec<u8>>(3)?,
                ))
            },
        )
        .optional()?;

    Ok(row.and_then(|(content_hash, model, dim, bytes)| {
        decode(&bytes).map(|vec| StoredVector {
            content_hash,
            model,
            dim,
            vec,
        })
    }))
}

/// Remove the vector for `path` (called from [`super::search::remove_note`], so
/// table ownership stays here in `vectors`).
pub fn remove_vector(db: &Connection, path: &str) -> CoreResult<()> {
    db.execute("DELETE FROM note_vectors WHERE path = ?1", params![path])?;
    Ok(())
}

/// Delete vectors whose note no longer exists in `note_meta` (e.g. notes deleted
/// while the app was closed, or moved/renamed offline). Safe to call only when
/// `note_meta` is fully populated — invoke after the index is built, never
/// mid-rebuild.
pub fn prune_orphans(db: &Connection) -> CoreResult<usize> {
    let n = db.execute(
        "DELETE FROM note_vectors
         WHERE path NOT IN (SELECT path FROM note_meta)",
        [],
    )?;
    Ok(n)
}

/// Map of path → stored content-hash for one model — the freshness oracle the
/// build uses to decide what needs (re)embedding.
pub fn vector_index(db: &Connection, model: &str) -> CoreResult<HashMap<String, String>> {
    let mut stmt = db.prepare("SELECT path, content_hash FROM note_vectors WHERE model = ?1")?;
    let rows = stmt.query_map(params![model], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// All (path, title, vector) for one model, joined against `note_meta` so
/// orphaned vectors (path missing from the live index) are excluded and titles
/// come from the index. Corrupt BLOBs are skipped.
pub fn candidates_for_model(
    db: &Connection,
    model: &str,
) -> CoreResult<Vec<(String, String, Vec<f32>)>> {
    let mut stmt = db.prepare(
        "SELECT v.path, m.title, v.vec
         FROM note_vectors v
         JOIN note_meta m ON m.path = v.path
         WHERE v.model = ?1",
    )?;
    let rows = stmt.query_map(params![model], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Vec<u8>>(2)?,
        ))
    })?;
    Ok(rows
        .filter_map(|r| r.ok())
        .filter_map(|(path, title, bytes)| decode(&bytes).map(|vec| (path, title, vec)))
        .collect())
}

/// Number of stored vectors for one model.
pub fn count_for_model(db: &Connection, model: &str) -> CoreResult<usize> {
    let n: i64 = db.query_row(
        "SELECT count(*) FROM note_vectors WHERE model = ?1",
        params![model],
        |r| r.get(0),
    )?;
    Ok(n as usize)
}

/// Count of notes eligible for embedding (local, non-placeholder) — a cheap
/// `COUNT(*)` for status display, without materializing the path list.
pub fn eligible_count(db: &Connection) -> CoreResult<usize> {
    let n: i64 = db.query_row(
        "SELECT count(*) FROM note_meta WHERE cloud_only = 0",
        [],
        |r| r.get(0),
    )?;
    Ok(n as usize)
}

/// (path, title) for every note eligible for embedding: real, locally-present
/// notes only — cloud-only placeholders are excluded (reading them would block
/// on a network download, and there's no body to embed).
pub fn eligible_notes(db: &Connection) -> CoreResult<Vec<(String, String)>> {
    let mut stmt = db.prepare("SELECT path, title FROM note_meta WHERE cloud_only = 0")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ---------------------------------------------------------------------------
// Build helper: read notes off the DB lock, hash, and select the stale ones.
// ---------------------------------------------------------------------------

/// For each `(path, title)` eligible note, read its body from disk, build the
/// embed text, and compare its hash to `index` (the stored hashes for the
/// current model). Returns only the notes that are missing or changed — each as
/// an [`EmbedJob`] carrying the *truncated* text to send and the *full*-text
/// hash to store.
///
/// Does its own filesystem reads, so the caller must run it **off** the engine
/// lock (a cloud-synced vault can hydrate online-only files here). Cloud-only
/// placeholders and empty-body notes are skipped.
pub fn collect_stale(
    vault: &Path,
    eligible: &[(String, String)],
    index: &HashMap<String, String>,
) -> Vec<EmbedJob> {
    let mut jobs = Vec::new();
    for (path, title) in eligible {
        let abs = vault.join(path);
        let meta = match std::fs::metadata(&abs) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if vault_fs::is_cloud_placeholder(&meta) {
            continue;
        }
        let content = match std::fs::read_to_string(&abs) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let (_, body) = frontmatter::parse_frontmatter(&content);
        // Skip notes with no body — embedding a bare title (or nothing) wastes a
        // provider call for ~no semantic signal.
        if body.trim().is_empty() {
            continue;
        }
        let full = embed_text(title, &body);
        let hash = content_hash(&full);
        if index.get(path).map(String::as_str) == Some(hash.as_str()) {
            continue; // up to date
        }
        jobs.push(EmbedJob {
            path: path.clone(),
            content_hash: hash,
            text: truncate_chars(&full, EMBED_CHAR_BUDGET),
        });
    }
    jobs
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema;

    fn mem_db() -> Connection {
        let dir = std::env::temp_dir().join(format!("novalis-vec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        schema::open_db(&dir.join("notes.db")).unwrap()
    }

    fn put_meta(db: &Connection, path: &str, title: &str, cloud_only: bool) {
        db.execute(
            "INSERT INTO note_meta (path, title, folder, created, modified, size, word_count, cloud_only)
             VALUES (?1, ?2, '', '', '', 0, 0, ?3)",
            params![path, title, cloud_only as i32],
        )
        .unwrap();
    }

    #[test]
    fn encode_decode_round_trips_including_negatives() {
        let v = vec![0.0f32, 1.5, -2.25, 1e-7, -123456.0];
        assert_eq!(decode(&encode(&v)).unwrap(), v);
    }

    #[test]
    fn decode_rejects_bad_length_without_panicking() {
        assert_eq!(decode(&[1, 2, 3]), None); // not a multiple of 4
        assert_eq!(decode(&[]), Some(vec![]));
    }

    #[test]
    fn cosine_identical_orthogonal_mismatch_and_zero() {
        let a = vec![1.0, 2.0, 3.0];
        assert!((cosine(&a, &a) - 1.0).abs() < 1e-6);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
        // dim mismatch → 0, not a panic
        assert_eq!(cosine(&[1.0, 2.0], &[1.0]), 0.0);
        // zero-norm → 0, not NaN
        let z = cosine(&[0.0, 0.0], &[1.0, 1.0]);
        assert_eq!(z, 0.0);
        assert!(!z.is_nan());
    }

    #[test]
    fn content_hash_is_deterministic_and_sensitive() {
        let h = content_hash("hello world");
        assert_eq!(h, content_hash("hello world"));
        assert_ne!(h, content_hash("hello worle"));
        assert_eq!(h.len(), 64); // sha256 hex
    }

    #[test]
    fn embed_text_combines_and_truncate_is_utf8_safe() {
        assert_eq!(embed_text("T", "B"), "T\n\nB");
        assert_eq!(embed_text("", "B"), "B");
        assert_eq!(embed_text("T", ""), "T");
        // Multibyte boundary: take 1 char of a 4-byte emoji → no panic, 1 char.
        let s = "😀😀😀";
        assert_eq!(truncate_chars(s, 1).chars().count(), 1);
        assert_eq!(truncate_chars(s, 10), s);
    }

    #[test]
    fn content_hash_uses_full_text_not_truncated() {
        // Two notes identical up to the budget but differing past it must hash
        // differently, so an edit beyond the cutoff still triggers a re-embed.
        let base: String = "x".repeat(EMBED_CHAR_BUDGET);
        let a = format!("{base}AAA");
        let b = format!("{base}BBB");
        assert_ne!(content_hash(&a), content_hash(&b));
        // …even though their truncations are equal.
        assert_eq!(
            truncate_chars(&a, EMBED_CHAR_BUDGET),
            truncate_chars(&b, EMBED_CHAR_BUDGET)
        );
    }

    #[test]
    fn upsert_get_remove_round_trip() {
        let db = mem_db();
        upsert_vector(&db, "a.md", "h1", "m1", &[1.0, 2.0, 3.0]).unwrap();
        let v = get_vector(&db, "a.md").unwrap().unwrap();
        assert_eq!(v.content_hash, "h1");
        assert_eq!(v.model, "m1");
        assert_eq!(v.dim, 3);
        assert_eq!(v.vec, vec![1.0, 2.0, 3.0]);

        // Re-upsert overwrites (PK = path) and updates model/hash/dim.
        upsert_vector(&db, "a.md", "h2", "m2", &[4.0, 5.0]).unwrap();
        let v = get_vector(&db, "a.md").unwrap().unwrap();
        assert_eq!(
            (v.content_hash.as_str(), v.model.as_str(), v.dim),
            ("h2", "m2", 2)
        );

        remove_vector(&db, "a.md").unwrap();
        assert!(get_vector(&db, "a.md").unwrap().is_none());
    }

    #[test]
    fn vector_index_and_candidates_filter_by_model_and_join_meta() {
        let db = mem_db();
        put_meta(&db, "a.md", "Alpha", false);
        put_meta(&db, "b.md", "Beta", false);
        upsert_vector(&db, "a.md", "ha", "modelA", &[1.0, 0.0]).unwrap();
        upsert_vector(&db, "b.md", "hb", "modelB", &[0.0, 1.0]).unwrap();

        let idx = vector_index(&db, "modelA").unwrap();
        assert_eq!(idx.len(), 1);
        assert_eq!(idx.get("a.md").map(String::as_str), Some("ha"));

        let cands = candidates_for_model(&db, "modelA").unwrap();
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].0, "a.md");
        assert_eq!(cands[0].1, "Alpha");

        assert_eq!(count_for_model(&db, "modelA").unwrap(), 1);
        assert_eq!(count_for_model(&db, "modelB").unwrap(), 1);
    }

    #[test]
    fn nearest_orders_by_score_excludes_self_and_respects_k() {
        let q = vec![1.0, 0.0];
        let cands = vec![
            ("self.md".into(), "Self".into(), vec![1.0, 0.0]),
            ("close.md".into(), "Close".into(), vec![0.9, 0.1]),
            ("far.md".into(), "Far".into(), vec![0.0, 1.0]),
            ("wrongdim.md".into(), "Wrong".into(), vec![1.0, 0.0, 0.0]),
        ];
        let hits = nearest(&cands, &q, 2, "self.md");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "close.md"); // highest cosine
        assert_eq!(hits[1].path, "far.md");
        assert!(hits.iter().all(|h| h.path != "self.md")); // excluded
        assert!(hits.iter().all(|h| h.path != "wrongdim.md")); // dim mismatch dropped
    }

    #[test]
    fn nearest_against_other_model_candidates_is_empty() {
        // candidates_for_model(modelB) won't include a modelA vector, so a query
        // built from modelA finds nothing under modelB.
        let db = mem_db();
        put_meta(&db, "a.md", "Alpha", false);
        upsert_vector(&db, "a.md", "ha", "modelA", &[1.0, 0.0]).unwrap();
        let cands = candidates_for_model(&db, "modelB").unwrap();
        assert!(nearest(&cands, &[1.0, 0.0], 5, "").is_empty());
    }

    #[test]
    fn prune_orphans_removes_only_dangling_vectors() {
        let db = mem_db();
        put_meta(&db, "live.md", "Live", false);
        upsert_vector(&db, "live.md", "h", "m", &[1.0]).unwrap();
        upsert_vector(&db, "ghost.md", "h", "m", &[1.0]).unwrap(); // no note_meta row

        assert_eq!(prune_orphans(&db).unwrap(), 1);
        assert!(get_vector(&db, "live.md").unwrap().is_some());
        assert!(get_vector(&db, "ghost.md").unwrap().is_none());
    }

    #[test]
    fn eligible_notes_excludes_cloud_only() {
        let db = mem_db();
        put_meta(&db, "local.md", "Local", false);
        put_meta(&db, "cloud.md", "Cloud", true);
        let eligible = eligible_notes(&db).unwrap();
        assert_eq!(eligible.len(), 1);
        assert_eq!(eligible[0].0, "local.md");
    }

    #[test]
    fn collect_stale_picks_missing_and_changed_skips_up_to_date() {
        let dir = std::env::temp_dir().join(format!("novalis-stale-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "---\ntitle: A\n---\nalpha body").unwrap();
        std::fs::write(dir.join("b.md"), "beta body").unwrap();
        std::fs::write(dir.join("empty.md"), "---\ntitle: E\n---\n   ").unwrap();

        let eligible = vec![
            ("a.md".to_string(), "A".to_string()),
            ("b.md".to_string(), "B".to_string()),
            ("empty.md".to_string(), "E".to_string()),
        ];

        // No stored hashes → all non-empty notes are stale.
        let mut index = HashMap::new();
        let jobs = collect_stale(&dir, &eligible, &index);
        assert_eq!(jobs.len(), 2, "a and b stale, empty skipped");
        let a_job = jobs.iter().find(|j| j.path == "a.md").unwrap();
        assert!(a_job.text.contains("alpha body"));

        // Mark `a` up to date with its real hash → only `b` remains stale.
        index.insert("a.md".to_string(), a_job.content_hash.clone());
        let jobs = collect_stale(&dir, &eligible, &index);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].path, "b.md");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_schema_is_idempotent_and_preserves_rows() {
        let db = mem_db(); // open_db already called ensure_schema
        upsert_vector(&db, "a.md", "h", "m", &[1.0, 2.0]).unwrap();
        ensure_schema(&db).unwrap(); // matching version → no drop
        assert!(get_vector(&db, "a.md").unwrap().is_some());
    }

    #[test]
    fn ensure_schema_drops_on_version_mismatch() {
        let db = mem_db();
        upsert_vector(&db, "a.md", "h", "m", &[1.0]).unwrap();
        // Simulate an older layout marker.
        db.execute("UPDATE note_vectors_meta SET version = 0", [])
            .unwrap();
        ensure_schema(&db).unwrap();
        assert!(
            get_vector(&db, "a.md").unwrap().is_none(),
            "stale-layout vectors dropped"
        );
        let v: i64 = db
            .query_row("SELECT version FROM note_vectors_meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, VECTORS_VERSION);
    }
}
