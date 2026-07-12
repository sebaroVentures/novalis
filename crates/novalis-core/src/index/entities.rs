//! The local **entity graph**: a *persistent* table of people/projects/orgs/
//! places extracted from note prose by an LLM, plus the notes that mention each
//! one — powering automatic entity backlinks and an "everything about X" view.
//!
//! ## Why this table is special (same contract as [`super::vectors`])
//!
//! Extracting entities is an **expensive LLM call** (network round-trips +
//! provider tokens), exactly like an embedding. So — mirroring `note_chunks` —
//! the `entities` / `entity_mentions` tables are deliberately **NOT** part of
//! the disposable-cache contract in [`super::schema`]: they are created and
//! versioned here (via [`ensure_schema`]) and are **never dropped by
//! `schema::drop_tables`**. A [`super::schema::SCHEMA_VERSION`] bump that
//! rebuilds the free FTS/meta caches therefore leaves the extracted entities
//! intact. The layout carries its own marker ([`ENTITIES_VERSION`] in
//! `entity_index_meta`); only a change to *that* drops and re-creates the tables
//! (a one-time re-extract).
//!
//! ## Resolution is alias-aware and case-insensitive
//!
//! An entity is keyed by its [`canonicalize`]d name (case-folded, whitespace-
//! collapsed) plus its [`EntityKind`]. When a newly-extracted entity shares any
//! canonical form — its name *or* any alias — with an existing entity of the
//! same kind, the two are **merged** ([`match_existing`] + [`merge_into`]): the
//! existing row keeps its id and display name, and the new surface forms fold
//! into its alias set. So "Bob", "Bob Smith", and "Robert Smith" collapse to one
//! entity as they're seen across notes.
//!
//! ## Mentions carry passages, not just note ids
//!
//! The model returns entity *names*, not offsets (it hallucinates spans). So a
//! mention's passage is computed **locally** by scanning the note body for the
//! entity's surface forms ([`find_mention`], word-boundary + case-insensitive),
//! recording the surrounding snippet and its character offsets. An entity the
//! model inferred but that appears under no literal surface form still gets a
//! mention (empty snippet, `0..0`) — it is genuinely *about* that note.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{CoreError, CoreResult};
use crate::models::{EntityKind, EntityMention, EntitySummary};

/// On-disk layout version for `entities` / `entity_mentions`. Bump only when the
/// tables' columns change — [`ensure_schema`] then drops + recreates them (a
/// one-time re-extract), independent of [`super::schema::SCHEMA_VERSION`].
pub const ENTITIES_VERSION: i64 = 1;

/// How many characters of context on either side of a matched surface form make
/// up a mention snippet (~a short passage — enough to see why the note is about
/// the entity, short enough to skim a list of them).
const SNIPPET_CONTEXT: usize = 60;

// ---------------------------------------------------------------------------
// Pure helpers (no DB / no IO) — the load-bearing, unit-tested core.
// ---------------------------------------------------------------------------

/// Stable lowercase tag stored in `entities.kind` and asked of the model.
pub fn kind_as_str(kind: EntityKind) -> &'static str {
    match kind {
        EntityKind::Person => "person",
        EntityKind::Project => "project",
        EntityKind::Org => "org",
        EntityKind::Place => "place",
        EntityKind::Other => "other",
    }
}

/// Parse a `kind` string from the model or the DB. Unknown/missing maps to
/// [`EntityKind::Other`] (a few common synonyms are folded in) — an entity is
/// never dropped just because its kind label was off.
pub fn kind_from_str(s: &str) -> EntityKind {
    match s.trim().to_ascii_lowercase().as_str() {
        "person" | "people" | "human" => EntityKind::Person,
        "project" | "initiative" => EntityKind::Project,
        "org" | "organization" | "organisation" | "company" | "team" => EntityKind::Org,
        "place" | "location" | "loc" => EntityKind::Place,
        _ => EntityKind::Other,
    }
}

/// The case-folded, whitespace-collapsed key an entity is deduped by. Lowercases
/// (Unicode-aware), trims, and collapses any run of whitespace to a single
/// space. Empty / whitespace-only input yields `""`.
pub fn canonicalize(name: &str) -> String {
    name.split_whitespace()
        .map(|w| w.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

/// One entity as the model proposed it (a parsed row of the STRICT-JSON
/// `extract-entities` result), before resolution against the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedEntity {
    pub name: String,
    pub kind: EntityKind,
    pub aliases: Vec<String>,
}

/// Strip a Markdown code fence the model may have wrapped its JSON in despite
/// the "no code fences" instruction (belt-and-suspenders — CLI providers have no
/// JSON mode). Returns the inner text trimmed; a fence-free input is unchanged.
fn strip_fences(s: &str) -> String {
    let t = s.trim();
    let t = t
        .strip_prefix("```json")
        .or_else(|| t.strip_prefix("```JSON"))
        .or_else(|| t.strip_prefix("```"))
        .unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t);
    t.trim().to_string()
}

/// Parse the `extract-entities` STRICT-JSON reply `{"entities":[{"name","kind",
/// "aliases"?}]}` into validated [`ExtractedEntity`] values. Pure.
///
/// - Entities with an empty (trimmed) name are dropped.
/// - `kind` is normalized via [`kind_from_str`]; a missing/unknown kind → Other.
/// - Aliases are trimmed, de-duplicated, and any alias equal (canonically) to
///   the name or another alias is dropped.
/// - The response is de-duplicated by `(kind, canonical name)`, merging the
///   aliases of any colliding rows — so the caller resolves a clean set.
///
/// Returns [`CoreError::BadRequest`] when the reply is not the expected JSON
/// (fail loud: the model produced junk rather than the contract).
pub fn parse_entities(raw: &str) -> CoreResult<Vec<ExtractedEntity>> {
    #[derive(serde::Deserialize)]
    struct RawReply {
        #[serde(default)]
        entities: Vec<RawEntity>,
    }
    #[derive(serde::Deserialize)]
    struct RawEntity {
        #[serde(default)]
        name: String,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        aliases: Vec<String>,
    }

    let cleaned = strip_fences(raw);
    let reply: RawReply = serde_json::from_str(&cleaned).map_err(|e| {
        CoreError::BadRequest(format!("the model did not return valid entity JSON: {e}"))
    })?;

    // Merge by (kind, canonical name), preserving first-seen order.
    let mut order: Vec<String> = Vec::new();
    let mut by_key: std::collections::HashMap<String, ExtractedEntity> =
        std::collections::HashMap::new();

    for raw in reply.entities {
        let name = raw.name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let kind = kind_from_str(raw.kind.as_deref().unwrap_or_default());
        let key = format!("{}\u{0}{}", kind_as_str(kind), canonicalize(&name));

        let entry = by_key.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            ExtractedEntity {
                name: name.clone(),
                kind,
                aliases: Vec::new(),
            }
        });
        for alias in raw.aliases {
            add_alias(entry, &alias);
        }
    }

    Ok(order
        .into_iter()
        .filter_map(|k| by_key.remove(&k))
        .collect())
}

/// Add `alias` to an entity's alias set unless it's empty or canonically equal to
/// the name or an existing alias. Keeps the original casing for display.
fn add_alias(entity: &mut ExtractedEntity, alias: &str) {
    let trimmed = alias.trim();
    if trimmed.is_empty() {
        return;
    }
    let canon = canonicalize(trimmed);
    if canon.is_empty() || canon == canonicalize(&entity.name) {
        return;
    }
    if entity.aliases.iter().any(|a| canonicalize(a) == canon) {
        return;
    }
    entity.aliases.push(trimmed.to_string());
}

/// A mention located in a note body: the surface form as it appeared, its
/// character span into the body, and a surrounding snippet. The pure output of
/// [`find_mention`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundMention {
    pub surface: String,
    pub char_start: u32,
    pub char_end: u32,
    pub snippet: String,
}

/// Lowercase one char to a single char, keeping a 1:1 mapping with the source so
/// character offsets stay aligned (ASCII + most Latin; a rare 1→N lowering keeps
/// only its first char). Good enough for locating a mention's offset.
fn lower_char(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Earliest word-boundary, case-insensitive occurrence of `needle` in `hay`
/// (both already lowercased, char slices). "Word-boundary" = the char before the
/// match and the char after it are not alphanumeric/underscore, so `"Al"` does
/// not match inside `"Also"`. Returns the char span `[start, end)`.
fn find_word_ci(hay: &[char], needle: &[char]) -> Option<(usize, usize)> {
    let m = needle.len();
    let n = hay.len();
    if m == 0 || m > n {
        return None;
    }
    for i in 0..=(n - m) {
        if hay[i..i + m] != *needle {
            continue;
        }
        let before_ok = i == 0 || !is_word_char(hay[i - 1]);
        let after_ok = i + m == n || !is_word_char(hay[i + m]);
        if before_ok && after_ok {
            return Some((i, i + m));
        }
    }
    None
}

/// Locate the earliest mention of any of `surfaces` in `body` — the entity's
/// name and aliases — case-insensitively and on word boundaries. Returns the
/// matched surface (original casing), its char offsets into `body`, and a
/// one-line snippet of surrounding context. Pure; UTF-8 safe (char offsets).
/// `None` when no surface form appears literally.
pub fn find_mention(body: &str, surfaces: &[String]) -> Option<FoundMention> {
    let chars: Vec<char> = body.chars().collect();
    let lower: Vec<char> = chars.iter().map(|c| lower_char(*c)).collect();

    let mut best: Option<(usize, usize)> = None;
    for surf in surfaces {
        let needle: Vec<char> = surf.chars().map(lower_char).collect();
        if let Some((s, e)) = find_word_ci(&lower, &needle) {
            if best.map(|(bs, _)| s < bs).unwrap_or(true) {
                best = Some((s, e));
            }
        }
    }
    let (s, e) = best?;
    let surface: String = chars[s..e].iter().collect();
    let snippet = extract_snippet(&chars, s, e);
    Some(FoundMention {
        surface,
        char_start: s as u32,
        char_end: e as u32,
        snippet,
    })
}

/// A one-line snippet of `chars[start-ctx .. end+ctx]` (clamped), whitespace
/// collapsed, with `…` where it was cut. Char-based, so never splits a codepoint.
fn extract_snippet(chars: &[char], s: usize, e: usize) -> String {
    let n = chars.len();
    let start = s.saturating_sub(SNIPPET_CONTEXT);
    let end = (e + SNIPPET_CONTEXT).min(n);
    let body: String = chars[start..end].iter().collect();
    let body = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::new();
    if start > 0 {
        out.push_str("… ");
    }
    out.push_str(&body);
    if end < n {
        out.push_str(" …");
    }
    out.trim().to_string()
}

/// An existing entity loaded for in-memory resolution: its id, display name,
/// kind, canonical key, and alias set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityRecord {
    pub id: i64,
    pub name: String,
    pub kind: EntityKind,
    pub canonical_name: String,
    pub aliases: Vec<String>,
}

/// Every canonical form a record answers to: its canonical name plus each alias.
fn record_canons(rec: &EntityRecord) -> Vec<String> {
    let mut v = vec![rec.canonical_name.clone()];
    v.extend(rec.aliases.iter().map(|a| canonicalize(a)));
    v
}

/// Canonical forms an extracted entity proposes: its name plus each alias
/// (empties dropped).
fn extracted_canons(e: &ExtractedEntity) -> Vec<String> {
    let mut v = vec![canonicalize(&e.name)];
    v.extend(e.aliases.iter().map(|a| canonicalize(a)));
    v.retain(|c| !c.is_empty());
    v
}

/// Index of the existing record `extracted` should merge into: **same kind** and
/// a shared canonical form (name or alias). `None` → it's a new entity. Pure.
pub fn match_existing(existing: &[EntityRecord], extracted: &ExtractedEntity) -> Option<usize> {
    let cands: HashSet<String> = extracted_canons(extracted).into_iter().collect();
    existing.iter().position(|rec| {
        rec.kind == extracted.kind && record_canons(rec).iter().any(|c| cands.contains(c))
    })
}

/// Fold an extracted entity's surface forms into `rec`'s alias set: its name and
/// each alias that isn't already the record's canonical name or an existing
/// alias becomes an alias (original casing kept). Returns whether the set
/// changed. Pure.
pub fn merge_into(rec: &mut EntityRecord, extracted: &ExtractedEntity) -> bool {
    let mut known: HashSet<String> = record_canons(rec).into_iter().collect();
    let mut changed = false;
    for surf in std::iter::once(&extracted.name).chain(extracted.aliases.iter()) {
        let canon = canonicalize(surf);
        if canon.is_empty() || known.contains(&canon) {
            continue;
        }
        rec.aliases.push(surf.trim().to_string());
        known.insert(canon);
        changed = true;
    }
    changed
}

// ---------------------------------------------------------------------------
// Schema (independent of the disposable index version).
// ---------------------------------------------------------------------------

const CREATE_ENTITIES: &str = "CREATE TABLE IF NOT EXISTS entities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        canonical_name TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]',
        UNIQUE(kind, canonical_name)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_canon ON entities(canonical_name);
    CREATE TABLE IF NOT EXISTS entity_mentions (
        entity_id INTEGER NOT NULL,
        note_path TEXT NOT NULL,
        note_title TEXT NOT NULL,
        surface TEXT NOT NULL,
        snippet TEXT NOT NULL,
        char_start INTEGER NOT NULL,
        char_end INTEGER NOT NULL,
        PRIMARY KEY (entity_id, note_path)
    );
    CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity ON entity_mentions(entity_id);
    CREATE INDEX IF NOT EXISTS idx_entity_mentions_note ON entity_mentions(note_path);";

/// Create the `entities` / `entity_mentions` tables (+ their layout-version
/// marker) if absent, and if the stored [`ENTITIES_VERSION`] differs, drop +
/// recreate them (a one-time re-extract). Called from [`super::schema::open_db`]
/// on every open; idempotent. Kept isolated from the free-cache rebuild in
/// `schema::drop_tables` so a [`super::schema::SCHEMA_VERSION`] bump preserves
/// the (expensive) extracted entities.
pub fn ensure_schema(conn: &Connection) -> CoreResult<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS entity_index_meta (version INTEGER NOT NULL);")?;

    let current: Option<i64> = conn
        .query_row("SELECT version FROM entity_index_meta LIMIT 1", [], |r| {
            r.get(0)
        })
        .optional()?;

    match current {
        Some(v) if v == ENTITIES_VERSION => {
            conn.execute_batch(CREATE_ENTITIES)?;
        }
        Some(_) => {
            // Layout changed: discard the (now-incompatible) entities; they'll be
            // re-extracted on demand. Isolated from schema::drop_tables.
            conn.execute_batch(
                "DROP TABLE IF EXISTS entity_mentions; DROP TABLE IF EXISTS entities;",
            )?;
            conn.execute_batch(CREATE_ENTITIES)?;
            conn.execute("DELETE FROM entity_index_meta", [])?;
            conn.execute(
                "INSERT INTO entity_index_meta (version) VALUES (?1)",
                params![ENTITIES_VERSION],
            )?;
        }
        None => {
            conn.execute_batch(CREATE_ENTITIES)?;
            conn.execute(
                "INSERT INTO entity_index_meta (version) VALUES (?1)",
                params![ENTITIES_VERSION],
            )?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Storage.
// ---------------------------------------------------------------------------

/// All entities as [`EntityRecord`]s for in-memory resolution (no mention join).
pub fn load_entity_records(db: &Connection) -> CoreResult<Vec<EntityRecord>> {
    let mut stmt = db.prepare("SELECT id, name, kind, canonical_name, aliases FROM entities")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    Ok(rows
        .filter_map(|r| super::ok_row_or_warn("entities", r))
        .map(|(id, name, kind, canonical_name, aliases)| EntityRecord {
            id,
            name,
            kind: kind_from_str(&kind),
            canonical_name,
            aliases: serde_json::from_str(&aliases).unwrap_or_default(),
        })
        .collect())
}

/// Insert a brand-new entity, returning its id.
pub fn insert_entity(
    db: &Connection,
    name: &str,
    kind: EntityKind,
    canonical_name: &str,
    aliases: &[String],
) -> CoreResult<i64> {
    let aliases_json = serde_json::to_string(aliases).unwrap_or_else(|_| "[]".to_string());
    db.execute(
        "INSERT INTO entities (name, kind, canonical_name, aliases) VALUES (?1, ?2, ?3, ?4)",
        params![name, kind_as_str(kind), canonical_name, aliases_json],
    )?;
    Ok(db.last_insert_rowid())
}

/// Overwrite one entity's alias set (after a merge).
pub fn update_entity_aliases(db: &Connection, id: i64, aliases: &[String]) -> CoreResult<()> {
    let aliases_json = serde_json::to_string(aliases).unwrap_or_else(|_| "[]".to_string());
    db.execute(
        "UPDATE entities SET aliases = ?1 WHERE id = ?2",
        params![aliases_json, id],
    )?;
    Ok(())
}

/// Delete every mention rooted in `note_path` (before a re-extract replaces
/// them, or when the note is removed).
pub fn clear_note_mentions(db: &Connection, note_path: &str) -> CoreResult<()> {
    db.execute(
        "DELETE FROM entity_mentions WHERE note_path = ?1",
        params![note_path],
    )?;
    Ok(())
}

/// Insert (or replace) one mention. `INSERT OR REPLACE` so two surface forms of
/// the same entity in one note collapse to a single mention row.
#[allow(clippy::too_many_arguments)]
pub fn insert_mention(
    db: &Connection,
    entity_id: i64,
    note_path: &str,
    note_title: &str,
    surface: &str,
    snippet: &str,
    char_start: u32,
    char_end: u32,
) -> CoreResult<()> {
    db.execute(
        "INSERT OR REPLACE INTO entity_mentions
            (entity_id, note_path, note_title, surface, snippet, char_start, char_end)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![entity_id, note_path, note_title, surface, snippet, char_start, char_end],
    )?;
    Ok(())
}

/// Resolve `extracted` against the store, upsert the entities, and **replace**
/// `note_path`'s mentions with the fresh set. The one-call orchestrator behind
/// the extraction command; the caller wraps it in the engine lock.
///
/// Resolution reuses the pure [`match_existing`] / [`merge_into`] against a
/// snapshot of the store that's updated as it goes, so two extracted entities in
/// the same batch that alias each other still collapse to one row. Each mention's
/// passage comes from scanning `body` for the entity's surface forms
/// ([`find_mention`]); an inferred entity with no literal match still gets a
/// mention (empty snippet). Returns the number of mentions written.
pub fn apply_note_extraction(
    db: &Connection,
    note_path: &str,
    note_title: &str,
    body: &str,
    extracted: &[ExtractedEntity],
) -> CoreResult<usize> {
    let mut records = load_entity_records(db)?;
    clear_note_mentions(db, note_path)?;

    let mut written = 0usize;
    for e in extracted {
        let entity_id = match match_existing(&records, e) {
            Some(i) => {
                if merge_into(&mut records[i], e) {
                    update_entity_aliases(db, records[i].id, &records[i].aliases)?;
                }
                records[i].id
            }
            None => {
                let canon = canonicalize(&e.name);
                let id = insert_entity(db, &e.name, e.kind, &canon, &e.aliases)?;
                records.push(EntityRecord {
                    id,
                    name: e.name.clone(),
                    kind: e.kind,
                    canonical_name: canon,
                    aliases: e.aliases.clone(),
                });
                id
            }
        };

        let mut surfaces = vec![e.name.clone()];
        surfaces.extend(e.aliases.iter().cloned());
        let (surface, snippet, cs, ce) = match find_mention(body, &surfaces) {
            Some(m) => (m.surface, m.snippet, m.char_start, m.char_end),
            None => (e.name.clone(), String::new(), 0, 0),
        };
        insert_mention(
            db, entity_id, note_path, note_title, &surface, &snippet, cs, ce,
        )?;
        written += 1;
    }
    Ok(written)
}

/// Decode a `(id, name, kind, canonical_name, aliases, mention_count)` row into
/// an [`EntitySummary`].
fn to_summary(
    id: i64,
    name: String,
    kind: String,
    canonical_name: String,
    aliases: String,
    count: i64,
) -> EntitySummary {
    EntitySummary {
        id,
        name,
        kind: kind_from_str(&kind),
        canonical_name,
        aliases: serde_json::from_str(&aliases).unwrap_or_default(),
        mention_count: count.max(0) as u32,
    }
}

/// Every entity with at least one mention in a note still present in the index,
/// with that live mention count — the entities-panel list. Entities whose only
/// notes were deleted drop out (INNER JOINs + `HAVING`). Ordered by mention count
/// (desc), then name.
pub fn list_entities(db: &Connection) -> CoreResult<Vec<EntitySummary>> {
    let mut stmt = db.prepare(
        "SELECT e.id, e.name, e.kind, e.canonical_name, e.aliases, COUNT(m.note_path) AS cnt
         FROM entities e
         JOIN entity_mentions m ON m.entity_id = e.id
         JOIN note_meta n ON n.path = m.note_path
         GROUP BY e.id
         HAVING cnt > 0
         ORDER BY cnt DESC, e.name ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(to_summary(
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, i64>(5)?,
        ))
    })?;
    Ok(rows
        .filter_map(|r| super::ok_row_or_warn("entities", r))
        .collect())
}

/// Entities mentioned in one note (its "entity backlinks"), each carrying its
/// global live mention count. Ordered by name.
pub fn entities_in_note(db: &Connection, note_path: &str) -> CoreResult<Vec<EntitySummary>> {
    let mut stmt = db.prepare(
        "SELECT e.id, e.name, e.kind, e.canonical_name, e.aliases,
                (SELECT COUNT(*) FROM entity_mentions m2
                   JOIN note_meta n2 ON n2.path = m2.note_path
                  WHERE m2.entity_id = e.id) AS cnt
         FROM entities e
         JOIN entity_mentions m ON m.entity_id = e.id
         WHERE m.note_path = ?1
         ORDER BY e.name ASC",
    )?;
    let rows = stmt.query_map(params![note_path], |r| {
        Ok(to_summary(
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, i64>(5)?,
        ))
    })?;
    Ok(rows
        .filter_map(|r| super::ok_row_or_warn("entities", r))
        .collect())
}

/// All mentions of one entity across notes still in the index — the rows of the
/// "everything about X" view. Note titles come fresh from `note_meta` (so a
/// renamed note shows its current title). Ordered by note title.
pub fn mentions_for_entity(db: &Connection, entity_id: i64) -> CoreResult<Vec<EntityMention>> {
    let mut stmt = db.prepare(
        "SELECT m.note_path, n.title, m.surface, m.snippet, m.char_start, m.char_end
         FROM entity_mentions m
         JOIN note_meta n ON n.path = m.note_path
         WHERE m.entity_id = ?1
         ORDER BY n.title ASC, m.note_path ASC",
    )?;
    let rows = stmt.query_map(params![entity_id], |r| {
        Ok(EntityMention {
            note_path: r.get::<_, String>(0)?,
            note_title: r.get::<_, String>(1)?,
            surface: r.get::<_, String>(2)?,
            snippet: r.get::<_, String>(3)?,
            char_start: r.get::<_, i64>(4)? as u32,
            char_end: r.get::<_, i64>(5)? as u32,
        })
    })?;
    Ok(rows
        .filter_map(|r| super::ok_row_or_warn("entity_mentions", r))
        .collect())
}

/// Delete mentions whose note no longer exists in `note_meta` (notes deleted or
/// moved while the app was closed), then delete any entity left with no mentions.
/// Safe to call only when `note_meta` is fully populated. Returns the number of
/// mention rows removed.
pub fn prune_orphans(db: &Connection) -> CoreResult<usize> {
    let n = db.execute(
        "DELETE FROM entity_mentions WHERE note_path NOT IN (SELECT path FROM note_meta)",
        [],
    )?;
    db.execute(
        "DELETE FROM entities WHERE id NOT IN (SELECT DISTINCT entity_id FROM entity_mentions)",
        [],
    )?;
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema;

    fn mem_db() -> Connection {
        let dir = std::env::temp_dir().join(format!("novalis-ent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        schema::open_db(&dir.join("notes.db")).unwrap()
    }

    fn put_meta(db: &Connection, path: &str, title: &str) {
        db.execute(
            "INSERT INTO note_meta (path, title, folder, created, modified, size, word_count, cloud_only)
             VALUES (?1, ?2, '', '', '', 0, 1, 0)",
            params![path, title],
        )
        .unwrap();
    }

    fn extracted(name: &str, kind: EntityKind, aliases: &[&str]) -> ExtractedEntity {
        ExtractedEntity {
            name: name.to_string(),
            kind,
            aliases: aliases.iter().map(|s| s.to_string()).collect(),
        }
    }

    // --- kind + canonicalization -----------------------------------------

    #[test]
    fn kind_round_trips_and_is_lenient() {
        for k in [
            EntityKind::Person,
            EntityKind::Project,
            EntityKind::Org,
            EntityKind::Place,
            EntityKind::Other,
        ] {
            assert_eq!(kind_from_str(kind_as_str(k)), k);
        }
        assert_eq!(kind_from_str("Organization"), EntityKind::Org);
        assert_eq!(kind_from_str("  PEOPLE "), EntityKind::Person);
        assert_eq!(kind_from_str("gibberish"), EntityKind::Other);
        assert_eq!(kind_from_str(""), EntityKind::Other);
    }

    #[test]
    fn canonicalize_folds_case_and_collapses_whitespace() {
        assert_eq!(canonicalize("  Bob   Smith "), "bob smith");
        assert_eq!(canonicalize("ACME Corp"), "acme corp");
        assert_eq!(canonicalize("\t\n  "), "");
        // Same canonical form for case/whitespace variants.
        assert_eq!(
            canonicalize("Project  Apollo"),
            canonicalize("project apollo")
        );
    }

    // --- parse_entities ---------------------------------------------------

    #[test]
    fn parse_entities_reads_valid_json_and_defaults_kind() {
        let raw = r#"{"entities":[
            {"name":"Bob Smith","kind":"person","aliases":["Bob"]},
            {"name":"Apollo","kind":"project"},
            {"name":"Mystery"}
        ]}"#;
        let out = parse_entities(raw).unwrap();
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].name, "Bob Smith");
        assert_eq!(out[0].kind, EntityKind::Person);
        assert_eq!(out[0].aliases, vec!["Bob".to_string()]);
        assert_eq!(out[1].kind, EntityKind::Project);
        // Missing kind → Other, never dropped.
        assert_eq!(out[2].name, "Mystery");
        assert_eq!(out[2].kind, EntityKind::Other);
    }

    #[test]
    fn parse_entities_tolerates_code_fences() {
        let raw = "```json\n{\"entities\":[{\"name\":\"Acme\",\"kind\":\"org\"}]}\n```";
        let out = parse_entities(raw).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, EntityKind::Org);
    }

    #[test]
    fn parse_entities_drops_empty_names_and_bad_aliases() {
        let raw = r#"{"entities":[
            {"name":"  ","kind":"person"},
            {"name":"Bob","kind":"person","aliases":["Bob","  ","bob"]}
        ]}"#;
        let out = parse_entities(raw).unwrap();
        assert_eq!(out.len(), 1, "empty-name entity dropped");
        // "Bob" equals the name canonically, blank is empty → no aliases kept.
        assert!(out[0].aliases.is_empty());
    }

    #[test]
    fn parse_entities_merges_duplicates_within_response() {
        let raw = r#"{"entities":[
            {"name":"Bob Smith","kind":"person","aliases":["Bob"]},
            {"name":"bob  smith","kind":"person","aliases":["Bobby"]}
        ]}"#;
        let out = parse_entities(raw).unwrap();
        assert_eq!(out.len(), 1, "same (kind, canonical) merged");
        assert!(out[0].aliases.contains(&"Bob".to_string()));
        assert!(out[0].aliases.contains(&"Bobby".to_string()));
    }

    #[test]
    fn parse_entities_same_name_different_kind_is_two() {
        let raw = r#"{"entities":[
            {"name":"Mercury","kind":"place"},
            {"name":"Mercury","kind":"project"}
        ]}"#;
        assert_eq!(parse_entities(raw).unwrap().len(), 2);
    }

    #[test]
    fn parse_entities_rejects_invalid_json() {
        let err = parse_entities("not json at all").unwrap_err();
        assert!(matches!(err, CoreError::BadRequest(_)));
        // An empty entities array is valid (nothing extracted), not an error.
        assert!(parse_entities(r#"{"entities":[]}"#).unwrap().is_empty());
    }

    // --- find_mention -----------------------------------------------------

    #[test]
    fn find_mention_locates_case_insensitively_with_offsets() {
        let body = "We met with bob today about the roadmap.";
        let m = find_mention(body, &["Bob".to_string()]).unwrap();
        assert_eq!(m.surface, "bob"); // original casing from the body
        assert_eq!(&body[m.char_start as usize..m.char_end as usize], "bob");
        assert!(m.snippet.contains("bob"));
    }

    #[test]
    fn find_mention_respects_word_boundaries() {
        // "Al" must not match inside "Also"; the real "Al" later does.
        let body = "Also, Al joined.";
        let m = find_mention(body, &["Al".to_string()]).unwrap();
        let start = m.char_start as usize;
        assert_eq!(&body[start..m.char_end as usize], "Al");
        assert!(start > 3, "matched the standalone Al, not inside 'Also'");
    }

    #[test]
    fn find_mention_picks_earliest_surface_and_handles_none() {
        let body = "Robert and Bob are the same person.";
        // Both surfaces present; the earliest offset wins ("Robert" at 0).
        let m = find_mention(body, &["Bob".to_string(), "Robert".to_string()]).unwrap();
        assert_eq!(m.char_start, 0);
        assert_eq!(m.surface, "Robert");
        assert!(find_mention(body, &["Nobody".to_string()]).is_none());
    }

    #[test]
    fn find_mention_is_utf8_safe() {
        // Offsets are CHAR indices (matching the vectors/RAG convention), so past
        // the leading multibyte chars they differ from byte indices — `surface`
        // (char-sliced) is the value to assert, and the char span must locate it.
        let body = "café ☕ with Renée in the café.";
        let m = find_mention(body, &["Renée".to_string()]).unwrap();
        assert_eq!(m.surface, "Renée");
        let chars: Vec<char> = body.chars().collect();
        let span: String = chars[m.char_start as usize..m.char_end as usize]
            .iter()
            .collect();
        assert_eq!(span, "Renée");
    }

    // --- resolution (pure) ------------------------------------------------

    fn record(id: i64, name: &str, kind: EntityKind, aliases: &[&str]) -> EntityRecord {
        EntityRecord {
            id,
            name: name.to_string(),
            kind,
            canonical_name: canonicalize(name),
            aliases: aliases.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn match_existing_is_alias_aware_and_kind_sensitive() {
        let existing = vec![record(1, "Bob Smith", EntityKind::Person, &["Bob"])];
        // Match by alias.
        assert_eq!(
            match_existing(&existing, &extracted("Bob", EntityKind::Person, &[])),
            Some(0)
        );
        // Match by a NEW alias that overlaps the record's name.
        assert_eq!(
            match_existing(
                &existing,
                &extracted("Someone", EntityKind::Person, &["Bob Smith"])
            ),
            Some(0)
        );
        // Same surface, different kind → no match.
        assert_eq!(
            match_existing(&existing, &extracted("Bob", EntityKind::Project, &[])),
            None
        );
        // Unrelated → no match.
        assert_eq!(
            match_existing(&existing, &extracted("Alice", EntityKind::Person, &[])),
            None
        );
    }

    #[test]
    fn merge_into_adds_only_new_surface_forms() {
        let mut rec = record(1, "Bob Smith", EntityKind::Person, &["Bob"]);
        // "Bob" already known, "Robert" is new, name repeat ignored.
        let changed = merge_into(
            &mut rec,
            &extracted("bob smith", EntityKind::Person, &["Bob", "Robert"]),
        );
        assert!(changed);
        assert!(rec.aliases.contains(&"Robert".to_string()));
        assert_eq!(
            rec.aliases
                .iter()
                .filter(|a| canonicalize(a) == "bob")
                .count(),
            1
        );
        // Idempotent: nothing new to add.
        assert!(!merge_into(
            &mut rec,
            &extracted("Bob", EntityKind::Person, &["Robert"])
        ));
    }

    // --- schema versioning ------------------------------------------------

    #[test]
    fn ensure_schema_is_idempotent_and_preserves_rows() {
        let db = mem_db(); // open_db already ran ensure_schema
        put_meta(&db, "a.md", "A");
        apply_note_extraction(
            &db,
            "a.md",
            "A",
            "About Bob.",
            &[extracted("Bob", EntityKind::Person, &[])],
        )
        .unwrap();
        ensure_schema(&db).unwrap(); // matching version → no drop
        assert_eq!(list_entities(&db).unwrap().len(), 1);
    }

    #[test]
    fn ensure_schema_drops_on_version_mismatch() {
        let db = mem_db();
        put_meta(&db, "a.md", "A");
        apply_note_extraction(
            &db,
            "a.md",
            "A",
            "About Bob.",
            &[extracted("Bob", EntityKind::Person, &[])],
        )
        .unwrap();
        db.execute("UPDATE entity_index_meta SET version = 0", [])
            .unwrap();
        ensure_schema(&db).unwrap();
        assert!(
            list_entities(&db).unwrap().is_empty(),
            "stale-layout entities dropped"
        );
        let v: i64 = db
            .query_row("SELECT version FROM entity_index_meta", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, ENTITIES_VERSION);
    }

    // --- store round-trip -------------------------------------------------

    #[test]
    fn apply_note_extraction_inserts_and_lists_with_counts() {
        let db = mem_db();
        put_meta(&db, "meeting.md", "Kickoff");
        put_meta(&db, "notes.md", "Notes");

        apply_note_extraction(
            &db,
            "meeting.md",
            "Kickoff",
            "Bob and Acme kicked off Apollo.",
            &[
                extracted("Bob", EntityKind::Person, &[]),
                extracted("Acme", EntityKind::Org, &[]),
                extracted("Apollo", EntityKind::Project, &[]),
            ],
        )
        .unwrap();
        // Bob appears in a second note too.
        apply_note_extraction(
            &db,
            "notes.md",
            "Notes",
            "Bob followed up.",
            &[extracted("Bob", EntityKind::Person, &[])],
        )
        .unwrap();

        let list = list_entities(&db).unwrap();
        assert_eq!(list.len(), 3);
        // Bob leads (2 mentions), ordered by count desc.
        assert_eq!(list[0].name, "Bob");
        assert_eq!(list[0].mention_count, 2);

        // "Everything about Bob": both notes, fresh titles.
        let bob = list.iter().find(|e| e.name == "Bob").unwrap();
        let mentions = mentions_for_entity(&db, bob.id).unwrap();
        assert_eq!(mentions.len(), 2);
        assert!(mentions.iter().any(|m| m.note_path == "meeting.md"));
        assert!(mentions.iter().all(|m| !m.snippet.is_empty()));

        // Entity backlinks for the meeting note.
        let in_note = entities_in_note(&db, "meeting.md").unwrap();
        assert_eq!(in_note.len(), 3);
    }

    #[test]
    fn apply_note_extraction_dedupes_by_alias_across_notes() {
        let db = mem_db();
        put_meta(&db, "a.md", "A");
        put_meta(&db, "b.md", "B");

        apply_note_extraction(
            &db,
            "a.md",
            "A",
            "Robert Smith leads.",
            &[extracted("Robert Smith", EntityKind::Person, &["Bob"])],
        )
        .unwrap();
        // A later note calls him "Bob" — must merge into the SAME entity via alias.
        apply_note_extraction(
            &db,
            "b.md",
            "B",
            "Bob agreed.",
            &[extracted("Bob", EntityKind::Person, &[])],
        )
        .unwrap();

        let list = list_entities(&db).unwrap();
        assert_eq!(list.len(), 1, "aliased names collapse to one entity");
        assert_eq!(list[0].mention_count, 2);
        assert_eq!(list[0].name, "Robert Smith"); // first-seen display name kept
    }

    #[test]
    fn re_extracting_a_note_replaces_its_mentions() {
        let db = mem_db();
        put_meta(&db, "a.md", "A");
        apply_note_extraction(
            &db,
            "a.md",
            "A",
            "Bob and Alice.",
            &[
                extracted("Bob", EntityKind::Person, &[]),
                extracted("Alice", EntityKind::Person, &[]),
            ],
        )
        .unwrap();
        assert_eq!(list_entities(&db).unwrap().len(), 2);

        // Re-extract with only Bob → Alice's mention for this note is gone, so
        // Alice (no other note) drops out of the live list.
        apply_note_extraction(
            &db,
            "a.md",
            "A",
            "Bob only.",
            &[extracted("Bob", EntityKind::Person, &[])],
        )
        .unwrap();
        let list = list_entities(&db).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Bob");
    }

    #[test]
    fn two_surface_forms_in_one_note_make_one_mention() {
        let db = mem_db();
        put_meta(&db, "a.md", "A");
        // "Robert" and "Bob" both resolve to one entity; one mention per note.
        apply_note_extraction(
            &db,
            "a.md",
            "A",
            "Robert, aka Bob, spoke.",
            &[
                extracted("Robert", EntityKind::Person, &["Bob"]),
                extracted("Bob", EntityKind::Person, &["Robert"]),
            ],
        )
        .unwrap();
        let list = list_entities(&db).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(
            list[0].mention_count, 1,
            "collapsed to a single mention row"
        );
    }

    #[test]
    fn prune_orphans_drops_mentions_of_deleted_notes_and_empty_entities() {
        let db = mem_db();
        put_meta(&db, "a.md", "A");
        put_meta(&db, "b.md", "B");
        apply_note_extraction(
            &db,
            "a.md",
            "A",
            "Only-here Ann.",
            &[extracted("Ann", EntityKind::Person, &[])],
        )
        .unwrap();
        apply_note_extraction(
            &db,
            "b.md",
            "B",
            "Ann and Ben.",
            &[
                extracted("Ann", EntityKind::Person, &[]),
                extracted("Ben", EntityKind::Person, &[]),
            ],
        )
        .unwrap();

        // Simulate an offline delete of b.md.
        db.execute("DELETE FROM note_meta WHERE path = 'b.md'", [])
            .unwrap();
        // Before prune, list already hides b's mentions (join), but the rows linger.
        let pruned = prune_orphans(&db).unwrap();
        assert_eq!(pruned, 2, "both of b's mention rows removed");
        // Ann still has a.md; Ben had only b.md → entity gone.
        let list = list_entities(&db).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Ann");
        assert!(mentions_for_entity(&db, list[0].id)
            .unwrap()
            .iter()
            .all(|m| m.note_path == "a.md"));
    }

    #[test]
    fn list_entities_hides_entities_whose_only_note_was_deleted() {
        let db = mem_db();
        put_meta(&db, "a.md", "A");
        apply_note_extraction(
            &db,
            "a.md",
            "A",
            "Ghost Gary.",
            &[extracted("Gary", EntityKind::Person, &[])],
        )
        .unwrap();
        db.execute("DELETE FROM note_meta WHERE path = 'a.md'", [])
            .unwrap();
        // The join excludes the dead note even before an explicit prune.
        assert!(list_entities(&db).unwrap().is_empty());
    }
}
