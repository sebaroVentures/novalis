//! On-device semantic vectors: a *persistent* table of **chunk-level** note
//! embeddings plus a native ANN index, powering "find related notes", semantic
//! search, and (soon) passage-precise RAG citations.
//!
//! ## Chunk-level, not note-level
//!
//! A note is split into ~paragraph, ~512-token chunks with a small overlap
//! ([`chunk_text`]); every chunk is embedded and stored as its own row in
//! `note_chunks`, keyed by `(path, model, chunk_ord)` and carrying the chunk's
//! character offsets into the note's embed text. Retrieval matches at the chunk
//! level (precise passages) and then *aggregates* the best chunk per note back
//! to a note result ([`retrieve_related`]); the winning chunk's offsets ride
//! along so a future `[[note#passage]]` citation can point at the exact span.
//!
//! ## Why this table is special
//!
//! Unlike the rest of the index (note_meta/notes_fts/links/…), embeddings are
//! **expensive to recompute** — every vector costs a network round-trip or local
//! model inference. So `note_chunks` is deliberately **NOT** part of the
//! disposable-cache contract in [`super::schema`]: it is created and versioned
//! here (via [`ensure_schema`]) and is **never dropped by
//! `schema::drop_tables`**. A `SCHEMA_VERSION` bump that rebuilds the free
//! caches therefore leaves embeddings intact. The vector layout has its own
//! marker ([`VECTORS_VERSION`] in `note_vectors_meta`); only a change to *that*
//! drops and re-creates the table (a one-time re-embed).
//!
//! ## Native ANN, off the write-lock
//!
//! Similarity search runs over a pure-Rust HNSW graph ([`VectorIndex`], backed
//! by `hnsw_rs`) built from the snapshotted chunk rows, so the k-NN scan never
//! holds the engine mutex. HNSW picks the *native ANN over the vec0 SQLite
//! extension* deliberately: the existing design stores several models of
//! different dimension in one table, which `vec0`'s fixed-dimension-per-table
//! layout cannot; and an in-memory index queries entirely off the DB connection.
//! The trade-off — the index is rebuilt from the table per retrieval, HNSW is
//! approximate (recall < 100%), and it costs RAM proportional to the vectors —
//! is surfaced, not hidden. Exact cosine ([`cosine`]) still scores every ANN
//! candidate, so the returned scores are exact even though selection is
//! approximate.
//!
//! ## Embedding stays out of the write path
//!
//! [`super::search::index_note`] / [`crate::change::reindex_path`] never touch
//! this table — per-keystroke autosave must not pay an embedding cost. Vectors
//! are (re)computed only by an explicit, batched build (the desktop
//! `ai_build_embeddings` command). The trade-off: a note edited after it was
//! embedded is *staler* than the index until the next build; that's surfaced,
//! not hidden.

use std::collections::HashMap;
use std::path::Path;

use hnsw_rs::prelude::{DistCosine, Hnsw};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::error::CoreResult;
use crate::vault::{frontmatter, fs as vault_fs};

/// On-disk layout version for `note_chunks`. Bump only when the table's columns
/// or the vector encoding change — [`ensure_schema`] then drops + recreates the
/// table (a one-time re-embed), independent of [`super::schema::SCHEMA_VERSION`].
///
/// v2 (this wave): moved from one whole-note vector per note in `note_vectors`
/// to one row **per chunk** in `note_chunks` (+ chunk_ord/char offsets).
pub const VECTORS_VERSION: i64 = 2;

/// Max characters of a note's embed text that get chunked + embedded. Long notes
/// are embedded from their leading portion only — a middle-ground budget (~3k
/// tokens across several chunks): large enough to capture most notes whole,
/// small enough to bound the per-note embedding cost. The staleness hash is
/// computed over the *full* text, so edits past the cutoff still trigger a
/// re-embed.
pub const EMBED_CHAR_BUDGET: usize = 12_000;

/// Target size of one chunk, in characters (~375 tokens at ~4 chars/token —
/// comfortably under the 512-token window of common small embedding models, so
/// the model rarely has to truncate a chunk).
pub const CHUNK_TARGET_CHARS: usize = 1_500;

/// How much a chunk overlaps its predecessor (~50 tokens): enough to keep a
/// sentence that straddles a boundary retrievable from either side.
pub const CHUNK_OVERLAP_CHARS: usize = 200;

/// Hard cap on a single chunk (~475 tokens). A paragraph longer than this with
/// no internal blank-line break is force-split into windows of this size.
pub const CHUNK_MAX_CHARS: usize = 1_900;

/// One chunk of a note's embed text: its position, its character span into that
/// text (char — not byte — offsets, matching [`truncate_chars`]), and the text
/// itself. Offsets are into the *truncated* embed source (see [`collect_stale`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub ord: u32,
    pub char_start: u32,
    pub char_end: u32,
    pub text: String,
}

/// A note that needs (re)embedding: where it lives, the hash of its full
/// embed-source (for staleness — shared by all its chunk rows), and the chunks
/// to embed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbedJob {
    pub path: String,
    pub content_hash: String,
    pub chunks: Vec<Chunk>,
}

/// One candidate chunk row, decoded: which note + chunk it is, its span, and its
/// vector. The undecoded form is [`chunk_rows_for_model`].
#[derive(Debug, Clone, PartialEq)]
pub struct ChunkRow {
    pub path: String,
    pub title: String,
    pub ord: u32,
    pub char_start: u32,
    pub char_end: u32,
    pub vec: Vec<f32>,
}

/// One similarity hit: a related note and its cosine score in `[-1, 1]`. The
/// public note-level result shape (unchanged).
#[derive(Debug, Clone, PartialEq)]
pub struct ScoredNote {
    pub path: String,
    pub title: String,
    pub score: f32,
}

/// A note hit that also remembers *which* chunk matched best — the aggregation
/// output of [`retrieve_related`]. Keeps the passage offsets for a future
/// `[[note#passage]]` citation; drop to a [`ScoredNote`] with [`Self::into_note`].
#[derive(Debug, Clone, PartialEq)]
pub struct RelatedChunk {
    pub path: String,
    pub title: String,
    pub score: f32,
    pub chunk_ord: u32,
    pub char_start: u32,
    pub char_end: u32,
}

impl RelatedChunk {
    /// Project to the note-level [`ScoredNote`] shape (dropping chunk offsets).
    pub fn into_note(self) -> ScoredNote {
        ScoredNote {
            path: self.path,
            title: self.title,
            score: self.score,
        }
    }
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
    if !bytes.len().is_multiple_of(4) {
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
/// codepoint). Used to bound the embed source; the hash uses the full text.
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

/// Split `text` into overlapping, paragraph-aware chunks. Pure and deterministic.
///
/// Greedy over character offsets: each chunk grows to the largest blank-line
/// (paragraph) boundary that keeps it within `target`; failing that, the
/// smallest boundary within `max`; failing that (a single paragraph longer than
/// `max`), a hard cut at `max`. Consecutive chunks overlap by `overlap` chars so
/// a sentence split across a boundary is retrievable from either side. Offsets
/// are *character* indices into `text`. Empty / whitespace-only input yields no
/// chunks. Every non-whitespace character lands in at least one chunk.
pub fn chunk_text(text: &str, target: usize, overlap: usize, max: usize) -> Vec<Chunk> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    if n == 0 {
        return Vec::new();
    }
    // Paragraph boundaries: an offset `i` is a boundary if it's the end of the
    // text or the start of a paragraph following a blank line (`\n\n`). Sorted
    // ascending, always ending with `n`.
    let mut boundaries: Vec<usize> = Vec::new();
    for i in 2..n {
        if chars[i - 1] == '\n' && chars[i - 2] == '\n' {
            boundaries.push(i);
        }
    }
    boundaries.push(n);

    let target = target.max(1);
    let max = max.max(target);
    let mut chunks = Vec::new();
    let mut ord = 0u32;
    let mut start = 0usize;
    while start < n {
        let hard = (start + max).min(n);
        let soft = start + target;
        // Boundaries strictly after `start` and within the hard cap.
        let within: Vec<usize> = boundaries
            .iter()
            .copied()
            .filter(|&b| b > start && b <= hard)
            .collect();
        let end = within
            .iter()
            .copied()
            .filter(|&b| b <= soft)
            .max()
            .or_else(|| within.first().copied())
            .unwrap_or(hard);

        let slice: String = chars[start..end].iter().collect();
        if !slice.trim().is_empty() {
            chunks.push(Chunk {
                ord,
                char_start: start as u32,
                char_end: end as u32,
                text: slice,
            });
            ord += 1;
        }
        if end >= n {
            break;
        }
        // Advance with overlap, but always make progress.
        start = (end.saturating_sub(overlap)).max(start + 1);
    }
    chunks
}

/// Chunk one note's embed source with the module's default parameters.
pub fn chunk_note(text: &str) -> Vec<Chunk> {
    chunk_text(
        text,
        CHUNK_TARGET_CHARS,
        CHUNK_OVERLAP_CHARS,
        CHUNK_MAX_CHARS,
    )
}

// ---------------------------------------------------------------------------
// Native ANN (pure — no DB): an in-memory HNSW over chunk vectors.
// ---------------------------------------------------------------------------

/// A native ANN index over a fixed set of vectors, addressed by the caller's own
/// ids (the position each vector was supplied in). Wraps `hnsw_rs`' HNSW graph
/// with the cosine distance. Selection is approximate; the caller re-scores hits
/// with exact [`cosine`], so returned *scores* stay exact.
pub struct VectorIndex {
    hnsw: Hnsw<'static, f32, DistCosine>,
    len: usize,
    dim: usize,
}

impl VectorIndex {
    /// HNSW graph degree — neighbours kept per node per layer. 16 is the library's
    /// well-worn default for mid-sized sets: good recall without a heavy graph.
    const MAX_NB_CONNECTION: usize = 16;
    /// Candidate-list width during construction. Larger → better graph, slower
    /// build; 200 is the common default.
    const EF_CONSTRUCTION: usize = 200;
    /// Number of graph layers.
    const MAX_LAYER: usize = 16;

    /// Build an index over `vectors`, ids implicit = each vector's position.
    /// Vectors whose length differs from the first are skipped (a corrupt/foreign
    /// row can't poison the graph). An empty input builds a queryable, empty
    /// index rather than failing.
    pub fn build(vectors: &[Vec<f32>]) -> Self {
        let dim = vectors.first().map(Vec::len).unwrap_or(0);
        let hnsw = Hnsw::<f32, DistCosine>::new(
            Self::MAX_NB_CONNECTION,
            vectors.len().max(1),
            Self::MAX_LAYER,
            Self::EF_CONSTRUCTION,
            DistCosine {},
        );
        let mut len = 0usize;
        for (id, v) in vectors.iter().enumerate() {
            if v.len() == dim && dim != 0 {
                hnsw.insert((v.as_slice(), id));
                len += 1;
            }
        }
        VectorIndex { hnsw, len, dim }
    }

    /// Approximate k-nearest ids to `query`, best first. Returns the supplied ids
    /// (positions), for the caller to re-score with exact [`cosine`]. An empty
    /// index, `k == 0`, or a dimension-mismatched query all return `[]`.
    pub fn search(&self, query: &[f32], k: usize) -> Vec<usize> {
        if self.len == 0 || k == 0 || query.len() != self.dim {
            return Vec::new();
        }
        let knbn = k.min(self.len);
        // ef ≥ k, with headroom, to recover recall lost to the graph's greediness.
        let ef = (k * 4).max(50);
        self.hnsw
            .search(query, knbn, ef)
            .into_iter()
            .map(|n| n.d_id)
            .collect()
    }
}

/// Chunk-level retrieval, aggregated to notes — the reusable primitive behind
/// "find related" and the future RAG wave. Builds a [`VectorIndex`] over
/// `candidates`, searches it with every `query` vector (a note is represented by
/// *all* its chunks), scores each hit with exact [`cosine`], then aggregates via
/// [`best_chunk_per_note`]: the single best chunk per note, dropping `exclude`,
/// top `k` best first. Pure — no DB, no IO. Selection is ANN-approximate; the
/// aggregation + scoring are exact.
pub fn retrieve_related(
    candidates: &[ChunkRow],
    queries: &[Vec<f32>],
    k: usize,
    exclude: &str,
) -> Vec<RelatedChunk> {
    if candidates.is_empty() || queries.is_empty() || k == 0 {
        return Vec::new();
    }
    let vectors: Vec<Vec<f32>> = candidates.iter().map(|c| c.vec.clone()).collect();
    let index = VectorIndex::build(&vectors);
    // Over-fetch per query so that self-chunks and duplicate-note hits don't
    // starve the final top-k after aggregation.
    let fetch = (k.saturating_mul(8)).max(k + 16);

    let mut hits: Vec<RelatedChunk> = Vec::new();
    for q in queries {
        for id in index.search(q, fetch) {
            let c = &candidates[id];
            hits.push(hit_from(c, cosine(q, &c.vec)));
        }
    }
    best_chunk_per_note(hits, k, exclude)
}

/// Aggregate chunk-level `hits` to notes: keep the single best-scoring chunk per
/// note (its offsets ride along for a future citation), drop `exclude`, sort by
/// score descending (ties broken by path for determinism), and keep the top `k`.
/// Pure — the exact half of [`retrieve_related`], independent of the ANN.
pub fn best_chunk_per_note(hits: Vec<RelatedChunk>, k: usize, exclude: &str) -> Vec<RelatedChunk> {
    let mut best: HashMap<String, RelatedChunk> = HashMap::new();
    for hit in hits {
        if hit.path == exclude {
            continue;
        }
        match best.entry(hit.path.clone()) {
            std::collections::hash_map::Entry::Occupied(mut e) => {
                if hit.score > e.get().score {
                    e.insert(hit);
                }
            }
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(hit);
            }
        }
    }

    let mut out: Vec<RelatedChunk> = best.into_values().collect();
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.path.cmp(&b.path))
    });
    out.truncate(k);
    out
}

fn hit_from(c: &ChunkRow, score: f32) -> RelatedChunk {
    RelatedChunk {
        path: c.path.clone(),
        title: c.title.clone(),
        score,
        chunk_ord: c.ord,
        char_start: c.char_start,
        char_end: c.char_end,
    }
}

/// Brute-force k-nearest by cosine over note-level `candidates`, excluding
/// `exclude` and any candidate whose dimension doesn't match `query`. Pure (no
/// DB): the exact reference retained for tests and small-N callers. Retrieval
/// itself now goes through [`retrieve_related`]'s ANN.
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

const CREATE_NOTE_CHUNKS: &str = "CREATE TABLE IF NOT EXISTS note_chunks (
        path TEXT NOT NULL,
        model TEXT NOT NULL,
        chunk_ord INTEGER NOT NULL,
        char_start INTEGER NOT NULL,
        char_end INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vec BLOB NOT NULL,
        PRIMARY KEY (path, model, chunk_ord)
    );
    CREATE INDEX IF NOT EXISTS idx_note_chunks_model ON note_chunks(model);
    CREATE INDEX IF NOT EXISTS idx_note_chunks_path ON note_chunks(path);";

/// Create `note_chunks` (+ its layout-version marker) if absent, and if the
/// stored [`VECTORS_VERSION`] differs, drop+recreate it (a one-time re-embed).
/// Called from [`super::schema::open_db`] on every open; idempotent. The marker
/// table is `note_vectors_meta` (reused from the v1 layout so an existing v1
/// install is detected and its legacy `note_vectors` table cleaned up).
pub fn ensure_schema(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS note_vectors_meta (version INTEGER NOT NULL);")?;

    let current: Option<i64> = conn
        .query_row("SELECT version FROM note_vectors_meta LIMIT 1", [], |r| {
            r.get(0)
        })
        .optional()?;

    match current {
        Some(v) if v == VECTORS_VERSION => {
            conn.execute_batch(CREATE_NOTE_CHUNKS)?;
        }
        Some(_) => {
            // Layout changed: discard the (now-incompatible) vectors. They'll be
            // re-embedded on the next build. Also drop the legacy v1
            // `note_vectors` table so it doesn't linger. Kept isolated from the
            // free-cache rebuild in schema::drop_tables.
            conn.execute_batch("DROP TABLE IF EXISTS note_vectors;")?;
            conn.execute_batch("DROP TABLE IF EXISTS note_chunks;")?;
            conn.execute_batch(CREATE_NOTE_CHUNKS)?;
            conn.execute("DELETE FROM note_vectors_meta", [])?;
            conn.execute(
                "INSERT INTO note_vectors_meta (version) VALUES (?1)",
                params![VECTORS_VERSION],
            )?;
        }
        None => {
            conn.execute_batch(CREATE_NOTE_CHUNKS)?;
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

/// Replace all chunk rows for `(path, model)` with `chunks` in one transaction
/// (delete-then-insert): a re-embed atomically swaps a note's whole chunk set,
/// leaving no partial/stale mix. Each element pairs a [`Chunk`] with its vector;
/// mismatched-length pairs are the caller's responsibility (zipped 1:1).
pub fn upsert_note_chunks(
    db: &Connection,
    path: &str,
    model: &str,
    content_hash: &str,
    chunks: &[(Chunk, Vec<f32>)],
) -> CoreResult<()> {
    db.execute(
        "DELETE FROM note_chunks WHERE path = ?1 AND model = ?2",
        params![path, model],
    )?;
    for (chunk, vec) in chunks {
        db.execute(
            "INSERT INTO note_chunks
                (path, model, chunk_ord, char_start, char_end, content_hash, dim, vec)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                path,
                model,
                chunk.ord,
                chunk.char_start,
                chunk.char_end,
                content_hash,
                vec.len() as i64,
                encode(vec)
            ],
        )?;
    }
    Ok(())
}

/// Remove every chunk for `path` (all models). Called from
/// [`super::search::remove_note`], so table ownership stays here in `vectors`.
pub fn remove_vector(db: &Connection, path: &str) -> CoreResult<()> {
    db.execute("DELETE FROM note_chunks WHERE path = ?1", params![path])?;
    Ok(())
}

/// Delete chunks whose note no longer exists in `note_meta` (e.g. notes deleted
/// while the app was closed, or moved/renamed offline). Safe to call only when
/// `note_meta` is fully populated — invoke after the index is built, never
/// mid-rebuild. Returns the number of rows removed.
pub fn prune_orphans(db: &Connection) -> CoreResult<usize> {
    let n = db.execute(
        "DELETE FROM note_chunks
         WHERE path NOT IN (SELECT path FROM note_meta)",
        [],
    )?;
    Ok(n)
}

/// Map of path → stored content-hash for one model — the freshness oracle the
/// build uses to decide what needs (re)embedding. All of a note's chunks share
/// its embed-text hash, so one row per path suffices (`GROUP BY path`).
pub fn chunk_hashes_for_model(db: &Connection, model: &str) -> CoreResult<HashMap<String, String>> {
    let mut stmt =
        db.prepare("SELECT path, content_hash FROM note_chunks WHERE model = ?1 GROUP BY path")?;
    let rows = stmt.query_map(params![model], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    Ok(rows
        .filter_map(|r| super::ok_row_or_warn("note_chunks", r))
        .collect())
}

/// Raw `(path, title, ord, char_start, char_end, vec-BLOB)` chunk rows for one
/// model, joined against `note_meta` so orphaned chunks (path missing from the
/// live index) are excluded and titles come from the index — the undecoded form
/// of [`chunk_candidates_for_model`], for callers that must decode outside a DB
/// lock (decoding a whole table is the expensive half).
#[allow(clippy::type_complexity)]
pub fn chunk_rows_for_model(
    db: &Connection,
    model: &str,
) -> CoreResult<Vec<(String, String, u32, u32, u32, Vec<u8>)>> {
    let mut stmt = db.prepare(
        "SELECT c.path, m.title, c.chunk_ord, c.char_start, c.char_end, c.vec
         FROM note_chunks c
         JOIN note_meta m ON m.path = c.path
         WHERE c.model = ?1",
    )?;
    let rows = stmt.query_map(params![model], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)? as u32,
            r.get::<_, i64>(3)? as u32,
            r.get::<_, i64>(4)? as u32,
            r.get::<_, Vec<u8>>(5)?,
        ))
    })?;
    Ok(rows
        .filter_map(|r| super::ok_row_or_warn("note_chunks", r))
        .collect())
}

/// Decode raw chunk rows into [`ChunkRow`]s, skipping corrupt BLOBs. Pure — the
/// no-DB second half of [`chunk_candidates_for_model`].
pub fn decode_chunk_rows(rows: Vec<(String, String, u32, u32, u32, Vec<u8>)>) -> Vec<ChunkRow> {
    rows.into_iter()
        .filter_map(|(path, title, ord, char_start, char_end, bytes)| {
            decode(&bytes).map(|vec| ChunkRow {
                path,
                title,
                ord,
                char_start,
                char_end,
                vec,
            })
        })
        .collect()
}

/// All decoded [`ChunkRow`] candidates for one model. Corrupt BLOBs are skipped.
pub fn chunk_candidates_for_model(db: &Connection, model: &str) -> CoreResult<Vec<ChunkRow>> {
    Ok(decode_chunk_rows(chunk_rows_for_model(db, model)?))
}

/// One note's stored chunk vectors for a model, ordered by `chunk_ord`, plus the
/// shared embed-text hash — the anchor's query vectors + freshness stamp for
/// "find related". `None` when the note has no chunks for the model (not
/// embedded yet). Corrupt BLOBs are skipped; the hash comes from the first row.
pub fn anchor_chunks(
    db: &Connection,
    path: &str,
    model: &str,
) -> CoreResult<Option<(String, Vec<Vec<f32>>)>> {
    let mut stmt = db.prepare(
        "SELECT content_hash, vec FROM note_chunks
         WHERE path = ?1 AND model = ?2 ORDER BY chunk_ord",
    )?;
    let rows = stmt.query_map(params![path, model], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
    })?;
    let mut hash: Option<String> = None;
    let mut vecs = Vec::new();
    for row in rows {
        let (h, bytes) = super::ok_row_or_warn("note_chunks", row).unwrap_or_default();
        if h.is_empty() {
            continue;
        }
        hash.get_or_insert(h);
        if let Some(v) = decode(&bytes) {
            vecs.push(v);
        }
    }
    Ok(hash.map(|h| (h, vecs)))
}

/// Number of notes (distinct paths) with at least one chunk for one model — the
/// coverage numerator the settings panel shows.
pub fn count_notes_for_model(db: &Connection, model: &str) -> CoreResult<usize> {
    let n: i64 = db.query_row(
        "SELECT count(DISTINCT path) FROM note_chunks WHERE model = ?1",
        params![model],
        |r| r.get(0),
    )?;
    Ok(n as usize)
}

/// Title of one note from `note_meta` (the same source the candidates join
/// reads), for recomputing the anchor's embed text at lookup time.
pub fn note_title(db: &Connection, path: &str) -> CoreResult<Option<String>> {
    let title = db
        .query_row(
            "SELECT title FROM note_meta WHERE path = ?1",
            params![path],
            |r| r.get(0),
        )
        .optional()?;
    Ok(title)
}

/// SQL predicate for embed-eligible notes: locally present (not a cloud-only
/// placeholder) and with a non-empty body (`word_count` is computed over the
/// post-frontmatter body, so `0` ⇔ nothing to embed). This must stay the same
/// filter [`collect_stale`] applies per note — if the count included notes the
/// build skips, coverage (`embedded >= total`) could never converge.
const ELIGIBLE_SQL: &str = "cloud_only = 0 AND word_count > 0";

/// Count of notes eligible for embedding — a cheap `COUNT(*)` for status
/// display, without materializing the path list.
pub fn eligible_count(db: &Connection) -> CoreResult<usize> {
    let n: i64 = db.query_row(
        &format!("SELECT count(*) FROM note_meta WHERE {ELIGIBLE_SQL}"),
        [],
        |r| r.get(0),
    )?;
    Ok(n as usize)
}

/// (path, title) for every note eligible for embedding: real, locally-present
/// notes with a body — cloud-only placeholders are excluded (reading them would
/// block on a network download) and so are empty notes (nothing to embed;
/// [`collect_stale`] would skip them anyway).
pub fn eligible_notes(db: &Connection) -> CoreResult<Vec<(String, String)>> {
    let mut stmt = db.prepare(&format!(
        "SELECT path, title FROM note_meta WHERE {ELIGIBLE_SQL}"
    ))?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows
        .filter_map(|r| super::ok_row_or_warn("note_meta", r))
        .collect())
}

// ---------------------------------------------------------------------------
// Build helper: read notes off the DB lock, hash, chunk, and select stale ones.
// ---------------------------------------------------------------------------

/// For each `(path, title)` eligible note, read its body from disk, build the
/// embed text, and compare its hash to `index` (the stored hashes for the
/// current model). Returns only the notes that are missing or changed — each as
/// an [`EmbedJob`] carrying the note's *chunks* (of the *truncated* source) and
/// the *full*-text hash to store on every chunk row.
///
/// Does its own filesystem reads, so the caller must run it **off** the engine
/// lock (a cloud-synced vault can hydrate online-only files here). Cloud-only
/// placeholders, empty-body notes, and notes that chunk to nothing are skipped.
pub fn collect_stale(
    vault: &Path,
    eligible: &[(String, String)],
    index: &HashMap<String, String>,
) -> Vec<EmbedJob> {
    let mut jobs = Vec::new();
    for (path, title) in eligible {
        let Some(full) = read_embed_text(vault, path, title) else {
            continue;
        };
        let hash = content_hash(&full);
        if index.get(path).map(String::as_str) == Some(hash.as_str()) {
            continue; // up to date
        }
        let source = truncate_chars(&full, EMBED_CHAR_BUDGET);
        let chunks = chunk_note(&source);
        if chunks.is_empty() {
            continue; // nothing to embed (all-whitespace after truncation)
        }
        jobs.push(EmbedJob {
            path: path.clone(),
            content_hash: hash,
            chunks,
        });
    }
    jobs
}

/// Read one note's current embed text (title + body) from disk — the same
/// metadata/placeholder/read/frontmatter pipeline [`collect_stale`] applies per
/// note, shared so freshness checks hash exactly what a build would embed.
/// `None` when the file is missing or unreadable, a cloud-only placeholder
/// (reading would block on a network download), or the body is empty
/// (embedding a bare title wastes a provider call for ~no semantic signal).
pub fn read_embed_text(vault: &Path, path: &str, title: &str) -> Option<String> {
    let abs = vault.join(path);
    let meta = std::fs::metadata(&abs).ok()?;
    if vault_fs::is_cloud_placeholder(&meta) {
        return None;
    }
    let content = std::fs::read_to_string(&abs).ok()?;
    let (_, body) = frontmatter::parse_frontmatter(&content);
    if body.trim().is_empty() {
        return None;
    }
    Some(embed_text(title, &body))
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
        put_meta_wc(db, path, title, cloud_only, 1);
    }

    fn put_meta_wc(db: &Connection, path: &str, title: &str, cloud_only: bool, word_count: i64) {
        db.execute(
            "INSERT INTO note_meta (path, title, folder, created, modified, size, word_count, cloud_only)
             VALUES (?1, ?2, '', '', '', 0, ?3, ?4)",
            params![path, title, word_count, cloud_only as i32],
        )
        .unwrap();
    }

    /// Store one whole-note vector as a single chunk — a shorthand for tests that
    /// only care about note-level retrieval, mirroring the old `upsert_vector`.
    fn put_vec(db: &Connection, path: &str, hash: &str, model: &str, vec: &[f32]) {
        let chunk = Chunk {
            ord: 0,
            char_start: 0,
            char_end: 0,
            text: String::new(),
        };
        upsert_note_chunks(db, path, model, hash, &[(chunk, vec.to_vec())]).unwrap();
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

    // --- chunking ---------------------------------------------------------

    #[test]
    fn chunk_text_empty_and_whitespace_yield_no_chunks() {
        assert!(chunk_text("", 100, 10, 120).is_empty());
        assert!(chunk_text("   \n\n  \n", 100, 10, 120).is_empty());
    }

    #[test]
    fn chunk_text_short_note_is_one_chunk_covering_all() {
        let c = chunk_text("hello world", 100, 10, 120);
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].ord, c[0].char_start, c[0].char_end), (0, 0, 11));
        assert_eq!(c[0].text, "hello world");
    }

    #[test]
    fn chunk_text_splits_on_paragraph_boundaries() {
        // Two paragraphs; a target smaller than the pair forces a split, and it
        // should land on the blank-line boundary (not mid-paragraph).
        let p1 = "a".repeat(60);
        let p2 = "b".repeat(60);
        let text = format!("{p1}\n\n{p2}");
        let c = chunk_text(&text, 70, 5, 100);
        assert_eq!(c.len(), 2, "one chunk per paragraph");
        // First chunk ends at the paragraph boundary (start of p2 = 62).
        assert_eq!(c[0].char_end, 62);
        assert!(c[0].text.starts_with(&p1));
        assert!(c[1].text.contains(&p2));
        // Ords are dense and increasing.
        assert_eq!((c[0].ord, c[1].ord), (0, 1));
    }

    #[test]
    fn chunk_text_force_splits_an_overlong_paragraph_with_overlap() {
        // A single 300-char paragraph, no blank lines: force-split at `max`.
        let text = "z".repeat(300);
        let c = chunk_text(&text, 100, 20, 100);
        assert!(c.len() >= 3, "300 chars / 100 max → at least 3 windows");
        // Windows overlap: each chunk after the first starts before the prior end.
        for w in c.windows(2) {
            assert!(w[1].char_start < w[0].char_end, "chunks overlap");
            assert!(w[1].char_start > w[0].char_start, "and make progress");
        }
        // Full coverage: last chunk reaches the end.
        assert_eq!(c.last().unwrap().char_end, 300);
    }

    #[test]
    fn chunk_text_offsets_are_char_not_byte_safe() {
        // Multibyte chars: offsets index characters, and slicing never panics.
        let text = "😀😀😀\n\n😀😀😀";
        let c = chunk_note(text);
        for chunk in &c {
            // char_end within char length; text length matches the span.
            let span = (chunk.char_end - chunk.char_start) as usize;
            assert_eq!(chunk.text.chars().count(), span);
        }
    }

    // --- ANN wrapper + retrieval -----------------------------------------

    fn brute_top_paths(cands: &[ChunkRow], q: &[f32], k: usize, exclude: &str) -> Vec<String> {
        let note: Vec<(String, String, Vec<f32>)> = cands
            .iter()
            .map(|c| (c.path.clone(), c.title.clone(), c.vec.clone()))
            .collect();
        nearest(&note, q, k, exclude)
            .into_iter()
            .map(|s| s.path)
            .collect()
    }

    fn chunk_row(path: &str, vec: Vec<f32>) -> ChunkRow {
        ChunkRow {
            path: path.into(),
            title: path.into(),
            ord: 0,
            char_start: 0,
            char_end: 0,
            vec,
        }
    }

    #[test]
    fn vector_index_empty_and_zero_k_are_safe() {
        let idx = VectorIndex::build(&[]);
        assert!(idx.search(&[1.0, 0.0], 5).is_empty());
        let idx = VectorIndex::build(&[vec![1.0, 0.0]]);
        assert!(idx.search(&[1.0, 0.0], 0).is_empty());
        // Dimension-mismatched query → no hits, no panic.
        assert!(idx.search(&[1.0, 0.0, 0.0], 5).is_empty());
    }

    #[test]
    fn vector_index_recalls_brute_force_nearest_in_its_top_hits() {
        // HNSW is approximate; assert the exact nearest is *among* the ANN's top
        // hits (recall), rather than pinning an exact rank that randomness can
        // permute. On a well-separated small set this recall is effectively 1.0.
        let cands: Vec<ChunkRow> = (0..12)
            .map(|i| {
                let a = i as f32;
                chunk_row(&format!("n{i}.md"), vec![a.cos(), a.sin()])
            })
            .collect();
        let vectors: Vec<Vec<f32>> = cands.iter().map(|c| c.vec.clone()).collect();
        let idx = VectorIndex::build(&vectors);
        let q = vec![1.0, 0.05];
        let ann: Vec<String> = idx
            .search(&q, 3)
            .iter()
            .map(|&i| cands[i].path.clone())
            .collect();
        let brute = brute_top_paths(&cands, &q, 1, "");
        assert!(ann.contains(&brute[0]), "exact nearest recalled by the ANN");
    }

    fn hit(path: &str, ord: u32, start: u32, end: u32, score: f32) -> RelatedChunk {
        RelatedChunk {
            path: path.into(),
            title: path.into(),
            score,
            chunk_ord: ord,
            char_start: start,
            char_end: end,
        }
    }

    #[test]
    fn best_chunk_per_note_keeps_best_chunk_excludes_and_orders() {
        // Deterministic (no ANN): b has two chunks — the higher-scoring one wins
        // and carries *its* offsets; a is excluded; results order by score.
        let hits = vec![
            hit("a.md", 0, 0, 10, 0.99), // anchor — excluded
            hit("b.md", 0, 5, 25, 0.90),
            hit("b.md", 1, 30, 50, 0.40), // same note, weaker chunk
            hit("c.md", 0, 0, 8, 0.70),
        ];
        let out = best_chunk_per_note(hits, 5, "a.md");
        assert!(out.iter().all(|h| h.path != "a.md"), "anchor excluded");
        assert_eq!(
            out.iter().filter(|h| h.path == "b.md").count(),
            1,
            "deduped"
        );
        assert_eq!(out[0].path, "b.md");
        // b's winning chunk is ord 0 (span 5..25), not the weaker ord 1.
        assert_eq!(
            (out[0].chunk_ord, out[0].char_start, out[0].char_end),
            (0, 5, 25)
        );
        assert_eq!(out[1].path, "c.md"); // 0.70 < b's 0.90
                                         // `k` truncates.
        assert_eq!(
            best_chunk_per_note(
                vec![hit("x.md", 0, 0, 1, 0.5), hit("y.md", 0, 0, 1, 0.4)],
                1,
                ""
            )
            .len(),
            1
        );
    }

    #[test]
    fn best_chunk_per_note_breaks_score_ties_by_path() {
        let hits = vec![hit("z.md", 0, 0, 1, 0.5), hit("a.md", 0, 0, 1, 0.5)];
        let out = best_chunk_per_note(hits, 5, "");
        assert_eq!(out[0].path, "a.md"); // tie → lexicographic path
        assert_eq!(out[1].path, "z.md");
    }

    #[test]
    fn retrieve_related_excludes_anchor_and_ranks_nearest_first() {
        // ANN integration: candidates clustered near the query so approximate
        // selection reliably includes them; assert only recall-robust facts —
        // the anchor is gone, the nearest note leads, and b is deduped to its
        // best chunk. (Farthest-neighbour ordering is intentionally not asserted:
        // an ANN may drop distant points.)
        let cands = vec![
            ChunkRow {
                path: "a.md".into(),
                title: "A".into(),
                ord: 0,
                char_start: 0,
                char_end: 10,
                vec: vec![1.0, 0.0],
            },
            ChunkRow {
                path: "b.md".into(),
                title: "B".into(),
                ord: 0,
                char_start: 5,
                char_end: 25,
                vec: vec![0.99, 0.02],
            },
            ChunkRow {
                path: "b.md".into(),
                title: "B".into(),
                ord: 1,
                char_start: 30,
                char_end: 50,
                vec: vec![0.6, 0.4],
            },
            ChunkRow {
                path: "c.md".into(),
                title: "C".into(),
                ord: 0,
                char_start: 0,
                char_end: 8,
                vec: vec![0.7, 0.3],
            },
        ];
        let queries = vec![vec![1.0, 0.0]];
        let hits = retrieve_related(&cands, &queries, 5, "a.md");
        assert!(hits.iter().all(|h| h.path != "a.md"), "anchor excluded");
        assert_eq!(hits[0].path, "b.md", "nearest note leads");
        // b's winning chunk is its aligned ord 0 (span 5..25), not ord 1.
        assert_eq!(
            (hits[0].chunk_ord, hits[0].char_start, hits[0].char_end),
            (0, 5, 25)
        );
        assert_eq!(
            hits.iter().filter(|h| h.path == "b.md").count(),
            1,
            "deduped"
        );
    }

    #[test]
    fn retrieve_related_recalls_brute_force_nearest() {
        // Deterministic 2-D directions around the circle; the exact brute-force
        // nearest note is recalled within the ANN's top-k (recall, not exact rank).
        let cands: Vec<ChunkRow> = (1..20)
            .map(|i| {
                let a = i as f32 * 0.31;
                chunk_row(&format!("n{i}.md"), vec![a.cos(), a.sin()])
            })
            .collect();
        let q = vec![(2.0f32).cos(), (2.0f32).sin()];
        let hits = retrieve_related(&cands, std::slice::from_ref(&q), 3, "");
        let brute = brute_top_paths(&cands, &q, 1, "");
        assert!(hits.iter().any(|h| h.path == brute[0]), "nearest recalled");
    }

    #[test]
    fn retrieve_related_edge_cases_are_empty() {
        let cands = vec![chunk_row("a.md", vec![1.0, 0.0])];
        assert!(retrieve_related(&cands, &[], 5, "").is_empty());
        assert!(retrieve_related(&[], &[vec![1.0, 0.0]], 5, "").is_empty());
        assert!(retrieve_related(&cands, &[vec![1.0, 0.0]], 0, "").is_empty());
    }

    // --- storage ----------------------------------------------------------

    #[test]
    fn upsert_replaces_whole_chunk_set_atomically() {
        let db = mem_db();
        let c0 = Chunk {
            ord: 0,
            char_start: 0,
            char_end: 5,
            text: "x".into(),
        };
        let c1 = Chunk {
            ord: 1,
            char_start: 4,
            char_end: 9,
            text: "y".into(),
        };
        upsert_note_chunks(
            &db,
            "a.md",
            "m1",
            "h1",
            &[(c0.clone(), vec![1.0, 0.0]), (c1, vec![0.0, 1.0])],
        )
        .unwrap();
        put_meta(&db, "a.md", "A", false);
        assert_eq!(count_notes_for_model(&db, "m1").unwrap(), 1);
        assert_eq!(chunk_candidates_for_model(&db, "m1").unwrap().len(), 2);

        // Re-upsert with a single chunk replaces the whole set (old ord 1 gone).
        upsert_note_chunks(&db, "a.md", "m1", "h2", &[(c0, vec![0.5, 0.5])]).unwrap();
        let rows = chunk_candidates_for_model(&db, "m1").unwrap();
        assert_eq!(rows.len(), 1);
        let hashes = chunk_hashes_for_model(&db, "m1").unwrap();
        assert_eq!(hashes.get("a.md").map(String::as_str), Some("h2"));
    }

    #[test]
    fn hashes_and_candidates_filter_by_model_and_join_meta() {
        let db = mem_db();
        put_meta(&db, "a.md", "Alpha", false);
        put_meta(&db, "b.md", "Beta", false);
        put_vec(&db, "a.md", "ha", "modelA", &[1.0, 0.0]);
        put_vec(&db, "b.md", "hb", "modelB", &[0.0, 1.0]);

        let idx = chunk_hashes_for_model(&db, "modelA").unwrap();
        assert_eq!(idx.len(), 1);
        assert_eq!(idx.get("a.md").map(String::as_str), Some("ha"));

        let cands = chunk_candidates_for_model(&db, "modelA").unwrap();
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].path, "a.md");
        assert_eq!(cands[0].title, "Alpha");

        assert_eq!(count_notes_for_model(&db, "modelA").unwrap(), 1);
        assert_eq!(count_notes_for_model(&db, "modelB").unwrap(), 1);
    }

    #[test]
    fn anchor_chunks_returns_hash_and_vectors_or_none() {
        let db = mem_db();
        put_meta(&db, "a.md", "A", false);
        let chunks = vec![
            (
                Chunk {
                    ord: 0,
                    char_start: 0,
                    char_end: 3,
                    text: "x".into(),
                },
                vec![1.0, 0.0],
            ),
            (
                Chunk {
                    ord: 1,
                    char_start: 2,
                    char_end: 6,
                    text: "y".into(),
                },
                vec![0.0, 1.0],
            ),
        ];
        upsert_note_chunks(&db, "a.md", "m", "hh", &chunks).unwrap();
        let (hash, vecs) = anchor_chunks(&db, "a.md", "m").unwrap().unwrap();
        assert_eq!(hash, "hh");
        assert_eq!(vecs, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
        // Missing note / wrong model → None.
        assert!(anchor_chunks(&db, "a.md", "other").unwrap().is_none());
        assert!(anchor_chunks(&db, "gone.md", "m").unwrap().is_none());
    }

    #[test]
    fn remove_and_prune_drop_chunks() {
        let db = mem_db();
        put_meta(&db, "live.md", "Live", false);
        put_vec(&db, "live.md", "h", "m", &[1.0]);
        put_vec(&db, "ghost.md", "h", "m", &[1.0]); // no note_meta row

        assert_eq!(prune_orphans(&db).unwrap(), 1);
        assert_eq!(count_notes_for_model(&db, "m").unwrap(), 1);

        remove_vector(&db, "live.md").unwrap();
        assert_eq!(count_notes_for_model(&db, "m").unwrap(), 0);
    }

    #[test]
    fn eligible_notes_excludes_cloud_only_and_empty() {
        let db = mem_db();
        put_meta(&db, "local.md", "Local", false);
        put_meta(&db, "cloud.md", "Cloud", true);
        put_meta_wc(&db, "empty.md", "Empty", false, 0);
        let eligible = eligible_notes(&db).unwrap();
        assert_eq!(eligible.len(), 1);
        assert_eq!(eligible[0].0, "local.md");
        assert_eq!(eligible_count(&db).unwrap(), 1);
    }

    #[test]
    fn coverage_converges_when_the_vault_has_empty_notes() {
        // One empty + two non-empty notes: the eligible count must exclude
        // exactly what collect_stale skips, so a build reaches
        // embedded == total (the panel's "up to date" condition).
        let dir = std::env::temp_dir().join(format!("novalis-cov-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "alpha body").unwrap();
        std::fs::write(dir.join("b.md"), "beta body").unwrap();
        std::fs::write(dir.join("empty.md"), "---\ntitle: E\n---\n   ").unwrap();

        let db = mem_db();
        put_meta_wc(&db, "a.md", "A", false, 2);
        put_meta_wc(&db, "b.md", "B", false, 2);
        put_meta_wc(&db, "empty.md", "E", false, 0);

        // The build pipeline: eligible list → stale scan → chunk rows per job.
        let eligible = eligible_notes(&db).unwrap();
        let jobs = collect_stale(&dir, &eligible, &HashMap::new());
        for job in &jobs {
            let rows: Vec<(Chunk, Vec<f32>)> = job
                .chunks
                .iter()
                .cloned()
                .map(|c| (c, vec![1.0, 0.0]))
                .collect();
            upsert_note_chunks(&db, &job.path, "m", &job.content_hash, &rows).unwrap();
        }

        let total = eligible_count(&db).unwrap();
        let embedded = count_notes_for_model(&db, "m").unwrap();
        assert_eq!(total, 2, "empty note excluded from the eligible count");
        assert_eq!(embedded, total, "coverage converges");

        std::fs::remove_dir_all(&dir).ok();
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

        // No stored hashes → all non-empty notes are stale, each with ≥1 chunk.
        let mut index = HashMap::new();
        let jobs = collect_stale(&dir, &eligible, &index);
        assert_eq!(jobs.len(), 2, "a and b stale, empty skipped");
        let a_job = jobs.iter().find(|j| j.path == "a.md").unwrap();
        assert!(!a_job.chunks.is_empty());
        assert!(a_job.chunks[0].text.contains("alpha body"));

        // Mark `a` up to date with its real hash → only `b` remains stale.
        index.insert("a.md".to_string(), a_job.content_hash.clone());
        let jobs = collect_stale(&dir, &eligible, &index);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].path, "b.md");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_embed_text_mirrors_collect_stale_skips() {
        let dir = std::env::temp_dir().join(format!("novalis-ret-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "---\ntitle: A\n---\nalpha body").unwrap();
        std::fs::write(dir.join("empty.md"), "   \n").unwrap();

        // Normal note: title + body, frontmatter stripped.
        assert_eq!(
            read_embed_text(&dir, "a.md", "A").as_deref(),
            Some("A\n\nalpha body")
        );
        // Empty body and missing file: not embeddable right now.
        assert_eq!(read_embed_text(&dir, "empty.md", "E"), None);
        assert_eq!(read_embed_text(&dir, "gone.md", "G"), None);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_schema_is_idempotent_and_preserves_rows() {
        let db = mem_db(); // open_db already called ensure_schema
        put_vec(&db, "a.md", "h", "m", &[1.0, 2.0]);
        ensure_schema(&db).unwrap(); // matching version → no drop
        assert_eq!(count_notes_for_model(&db, "m").unwrap(), 1);
    }

    #[test]
    fn ensure_schema_drops_on_version_mismatch() {
        let db = mem_db();
        put_vec(&db, "a.md", "h", "m", &[1.0]);
        // Simulate an older layout marker.
        db.execute("UPDATE note_vectors_meta SET version = 1", [])
            .unwrap();
        ensure_schema(&db).unwrap();
        assert_eq!(
            count_notes_for_model(&db, "m").unwrap(),
            0,
            "stale-layout vectors dropped"
        );
        let v: i64 = db
            .query_row("SELECT version FROM note_vectors_meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, VECTORS_VERSION);
    }

    #[test]
    fn ensure_schema_migrates_legacy_note_vectors_table() {
        // A fresh v1-style install: a `note_vectors` table + meta version 1.
        let dir = std::env::temp_dir().join(format!("novalis-mig-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("notes.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE note_vectors (path TEXT PRIMARY KEY, content_hash TEXT, model TEXT, dim INTEGER, vec BLOB);
                 CREATE TABLE note_vectors_meta (version INTEGER NOT NULL);
                 INSERT INTO note_vectors_meta (version) VALUES (1);
                 INSERT INTO note_vectors (path, content_hash, model, dim, vec) VALUES ('a.md','h','m',1, x'00000000');",
            )
            .unwrap();
        }
        // Opening through the real path runs ensure_schema → migrate to v2.
        let db = schema::open_db(&path).unwrap();
        let legacy: i64 = db
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='note_vectors'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(legacy, 0, "legacy note_vectors dropped");
        let v: i64 = db
            .query_row("SELECT version FROM note_vectors_meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, VECTORS_VERSION);
        // note_chunks exists and is empty (re-embed pending).
        assert_eq!(count_notes_for_model(&db, "m").unwrap(), 0);

        drop(db);
        std::fs::remove_dir_all(&dir).ok();
    }
}
