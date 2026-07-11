//! Typed frontmatter properties + typed relations index.
//!
//! Two disposable-cache tables (owned by [`super::schema`], rebuilt on a
//! version bump) that turn a note's custom frontmatter into queryable rows —
//! the data-layer foundation for a future query engine. Files stay the source
//! of truth; these tables are a rebuildable mirror, never authoritative.
//!
//! * `note_properties(path, key, kind, value)` — one row per custom frontmatter
//!   key, with the [`PropertyValue`] kind and a text encoding of its value.
//! * `note_relations(source_path, key, target_path)` — one forward row per
//!   relation: a text/list property whose (bracket-stripped) value resolves to
//!   an existing note's title. RECIPROCITY IS QUERY-DERIVED, mirroring the link
//!   graph: one forward row `(source, key, target)` answers both the outgoing
//!   query (`source_path = me`) and the incoming/reciprocal one
//!   (`target_path = me`) — see [`outgoing_relations`] / [`incoming_relations`].
//!   We deliberately do NOT store a mirrored reverse row: it would break the
//!   per-source replace pattern ([`index_properties`] owns only its own source's
//!   rows, exactly like `links::index_links`).
//!
//! Resolution mirrors [`crate::index::links`]: case-insensitive title match
//! against `note_meta`, fanning one value out to every note sharing that title
//! (the documented v1 title-collision limitation). The difference: relations
//! store the RESOLVED `target_path`, so a full rebuild is order-dependent (a
//! target indexed after its source wouldn't be in `note_meta` yet). That is
//! handled by [`resolve_all_relations`], a post-pass the full build runs once
//! `note_meta` is complete; incremental single-note reindex resolves correctly
//! in [`index_properties`] because every other note is already indexed.

use std::collections::HashSet;

use rusqlite::{params, Connection};

use crate::error::CoreResult;
use crate::models::{
    NotePropertyEntry, NoteRelations, PropertyValue, RelationRef, RollupOp, RollupResult,
};

// ── stored kinds ─────────────────────────────────────────────────────────────

/// The `kind` column values — the discriminants of [`PropertyValue`].
pub const KIND_TEXT: &str = "text";
pub const KIND_NUMBER: &str = "number";
pub const KIND_CHECKBOX: &str = "checkbox";
pub const KIND_LIST: &str = "list";

// ── pure value encoding (no DB) ──────────────────────────────────────────────

/// Encode a [`PropertyValue`] as the `(kind, value)` text pair stored in
/// `note_properties`. Numbers use their plain decimal form, checkboxes
/// `true`/`false`, and lists a JSON array of strings (so the elements survive a
/// round-trip through [`decode_value`] and relation extraction). Pure.
pub fn encode_value(value: &PropertyValue) -> (&'static str, String) {
    match value {
        PropertyValue::Text(s) => (KIND_TEXT, s.clone()),
        // JSON cannot carry NaN/Infinity; the read mapper never produces `None`,
        // but a hostile write could — store an empty string, which decodes back
        // to `Number(None)` rather than a bogus number.
        PropertyValue::Number(n) => (KIND_NUMBER, n.map(|f| f.to_string()).unwrap_or_default()),
        PropertyValue::Checkbox(b) => (KIND_CHECKBOX, b.to_string()),
        PropertyValue::List(items) => (
            KIND_LIST,
            serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string()),
        ),
    }
}

/// Inverse of [`encode_value`]: rebuild a [`PropertyValue`] from a stored
/// `(kind, value)`. A malformed number/list degrades to `Text` rather than
/// erroring, so a hand-corrupted cache row is still visible. Pure.
pub fn decode_value(kind: &str, value: &str) -> PropertyValue {
    match kind {
        KIND_NUMBER => match value.parse::<f64>() {
            Ok(f) => PropertyValue::Number(Some(f)),
            Err(_) if value.is_empty() => PropertyValue::Number(None),
            Err(_) => PropertyValue::Text(value.to_string()),
        },
        KIND_CHECKBOX => PropertyValue::Checkbox(value == "true"),
        KIND_LIST => match serde_json::from_str::<Vec<String>>(value) {
            Ok(items) => PropertyValue::List(items),
            Err(_) => PropertyValue::Text(value.to_string()),
        },
        // KIND_TEXT and any unknown kind.
        _ => PropertyValue::Text(value.to_string()),
    }
}

/// Parse a stored value as an `f64`, but only when the property is a number.
/// The rollups aggregate over exactly these. Pure.
pub fn value_as_number(kind: &str, value: &str) -> Option<f64> {
    if kind == KIND_NUMBER {
        value.parse::<f64>().ok()
    } else {
        None
    }
}

/// The candidate note title a single scalar value points at: a `[[wikilink]]`
/// unwrapped to its inner text, or the bare value itself. Trimmed; `None` when
/// empty. Pure — whether it actually resolves to a note is decided later.
pub fn relation_target_title(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let inner = trimmed
        .strip_prefix("[[")
        .and_then(|s| s.strip_suffix("]]"))
        .unwrap_or(trimmed)
        .trim();
    if inner.is_empty() {
        None
    } else {
        Some(inner.to_string())
    }
}

/// The relation-target candidate titles a stored `(kind, value)` can yield: a
/// text scalar gives 0–1, a list one per element, and numbers/checkboxes none.
/// Pure — resolution against `note_meta` happens in [`resolve_source`].
pub fn stored_relation_candidates(kind: &str, value: &str) -> Vec<String> {
    match kind {
        KIND_TEXT => relation_target_title(value).into_iter().collect(),
        KIND_LIST => serde_json::from_str::<Vec<String>>(value)
            .unwrap_or_default()
            .iter()
            .filter_map(|s| relation_target_title(s))
            .collect(),
        _ => Vec::new(),
    }
}

/// Aggregate numeric `values` under `op`. Pure — the load-bearing rollup core.
/// `Count` returns the value count and `Sum` returns `0.0` for an empty slice
/// (both always defined); `Avg`/`Min`/`Max` return `None` when there is nothing
/// to aggregate. Inputs are finite `f64`s (from [`value_as_number`]), so
/// `min`/`max` never see NaN.
pub fn rollup(op: RollupOp, values: &[f64]) -> Option<f64> {
    match op {
        RollupOp::Count => Some(values.len() as f64),
        RollupOp::Sum => Some(values.iter().sum()),
        RollupOp::Avg => {
            if values.is_empty() {
                None
            } else {
                Some(values.iter().sum::<f64>() / values.len() as f64)
            }
        }
        RollupOp::Min => values.iter().copied().reduce(f64::min),
        RollupOp::Max => values.iter().copied().reduce(f64::max),
    }
}

// ── population (write path) ──────────────────────────────────────────────────

/// Replace the `note_properties` and outgoing `note_relations` recorded for one
/// note. `entries` are the typed frontmatter properties from
/// [`crate::vault::frontmatter::properties_from_extra`].
///
/// Called per note by [`crate::index::search::index_note`], so relations resolve
/// against a fully-populated `note_meta` on an incremental edit. During a full
/// rebuild the order-dependence is corrected afterwards by
/// [`resolve_all_relations`].
pub fn index_properties(
    db: &Connection,
    source_path: &str,
    entries: &[NotePropertyEntry],
) -> CoreResult<()> {
    db.execute(
        "DELETE FROM note_properties WHERE path = ?1",
        params![source_path],
    )?;
    let mut stmt =
        db.prepare("INSERT INTO note_properties (path, key, kind, value) VALUES (?1, ?2, ?3, ?4)")?;
    for entry in entries {
        let (kind, value) = encode_value(&entry.value);
        stmt.execute(params![source_path, entry.key, kind, value])?;
    }
    resolve_source(db, source_path)
}

/// Rebuild the outgoing relations for `source_path` from its stored
/// `note_properties` rows (replace-by-source, like `links::index_links`). Reads
/// the rows back so relation resolution has a single implementation shared with
/// [`resolve_all_relations`].
fn resolve_source(db: &Connection, source_path: &str) -> CoreResult<()> {
    db.execute(
        "DELETE FROM note_relations WHERE source_path = ?1",
        params![source_path],
    )?;
    let rows = property_rows(db, Some(source_path))?;
    write_relations(db, &rows)
}

/// Discard and rebuild the ENTIRE `note_relations` table from `note_properties`,
/// resolving every value against the now-complete `note_meta`. The full-build
/// post-pass: per-note resolution during the build would miss any target not
/// yet indexed. Cheap (one title lookup per relation candidate) and idempotent.
pub fn resolve_all_relations(db: &Connection) -> CoreResult<()> {
    db.execute("DELETE FROM note_relations", [])?;
    let rows = property_rows(db, None)?;
    write_relations(db, &rows)
}

/// Remove a note's property/relation rows on delete or move-away. Clears BOTH
/// its outgoing rows (`source_path`) and the incoming rows other notes resolved
/// TO it (`target_path`): unlike `links` (which store an unresolved
/// `target_title` that simply stops JOINing), relations store a resolved
/// `target_path`, so a stale incoming row would otherwise dangle at a ghost
/// path. A later reindex of the still-present source re-creates the row if the
/// note reappears.
pub fn remove_properties(db: &Connection, path: &str) -> CoreResult<()> {
    db.execute("DELETE FROM note_properties WHERE path = ?1", params![path])?;
    db.execute(
        "DELETE FROM note_relations WHERE source_path = ?1 OR target_path = ?1",
        params![path],
    )?;
    Ok(())
}

/// Read `(path, key, kind, value)` property rows, for one source or all of them.
fn property_rows(
    db: &Connection,
    source: Option<&str>,
) -> CoreResult<Vec<(String, String, String, String)>> {
    let map = |r: &rusqlite::Row| -> rusqlite::Result<(String, String, String, String)> {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
    };
    let rows: Vec<(String, String, String, String)> = match source {
        Some(p) => {
            let mut stmt =
                db.prepare("SELECT path, key, kind, value FROM note_properties WHERE path = ?1")?;
            let rows = stmt
                .query_map(params![p], map)?
                .filter_map(|r| super::ok_row_or_warn("note_properties", r))
                .collect();
            rows
        }
        None => {
            let mut stmt = db.prepare("SELECT path, key, kind, value FROM note_properties")?;
            let rows = stmt
                .query_map([], map)?
                .filter_map(|r| super::ok_row_or_warn("note_properties", r))
                .collect();
            rows
        }
    };
    Ok(rows)
}

/// Resolve each property row's relation candidates and insert the forward
/// `note_relations` rows, deduped by `(source, key, target)` and skipping
/// self-relations. Assumes the affected relation rows were already cleared.
fn write_relations(db: &Connection, rows: &[(String, String, String, String)]) -> CoreResult<()> {
    let mut stmt = db.prepare(
        "INSERT INTO note_relations (source_path, key, target_path) VALUES (?1, ?2, ?3)",
    )?;
    let mut seen: HashSet<(String, String, String)> = HashSet::new();
    for (source, key, kind, value) in rows {
        for candidate in stored_relation_candidates(kind, value) {
            for target in resolve_title(db, &candidate)? {
                if &target == source {
                    continue; // a note relating to itself is not an edge
                }
                if seen.insert((source.clone(), key.clone(), target.clone())) {
                    stmt.execute(params![source, key, target])?;
                }
            }
        }
    }
    Ok(())
}

/// Existing note paths whose title matches `title` (case-insensitive). Fans out
/// to every note sharing a title — the same v1 limitation as the link graph,
/// pinned by a test so a future path-resolved scheme changes it deliberately.
fn resolve_title(db: &Connection, title: &str) -> CoreResult<Vec<String>> {
    let mut stmt =
        db.prepare("SELECT path FROM note_meta WHERE lower(title) = lower(?1) ORDER BY path")?;
    let rows = stmt
        .query_map(params![title], |r| r.get::<_, String>(0))?
        .filter_map(|r| super::ok_row_or_warn("note_meta", r))
        .collect();
    Ok(rows)
}

// ── query helpers (read path) ────────────────────────────────────────────────

/// The indexed properties of one note, decoded back to typed values in stored
/// order. Index-only; backs the `note_properties` command.
pub fn properties_for(db: &Connection, path: &str) -> CoreResult<Vec<NotePropertyEntry>> {
    let mut stmt = db.prepare("SELECT key, kind, value FROM note_properties WHERE path = ?1")?;
    let rows = stmt
        .query_map(params![path], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .filter_map(|r| super::ok_row_or_warn("note_properties", r))
        .map(|(key, kind, value)| NotePropertyEntry {
            key,
            value: decode_value(&kind, &value),
        })
        .collect();
    Ok(rows)
}

/// Notes `source_path`'s frontmatter points to (the outgoing relations), joined
/// to `note_meta` for their titles. Ordered by key then title for determinism.
pub fn outgoing_relations(db: &Connection, source_path: &str) -> CoreResult<Vec<RelationRef>> {
    let mut stmt = db.prepare(
        "SELECT m.path, m.title, r.key
         FROM note_relations r JOIN note_meta m ON m.path = r.target_path
         WHERE r.source_path = ?1
         ORDER BY r.key, m.title",
    )?;
    relation_refs(&mut stmt, source_path)
}

/// Notes whose frontmatter points to `target_path` (the reciprocal, incoming
/// relations), joined to `note_meta` for their titles. Same forward rows as
/// [`outgoing_relations`], read from the other end.
pub fn incoming_relations(db: &Connection, target_path: &str) -> CoreResult<Vec<RelationRef>> {
    let mut stmt = db.prepare(
        "SELECT m.path, m.title, r.key
         FROM note_relations r JOIN note_meta m ON m.path = r.source_path
         WHERE r.target_path = ?1
         ORDER BY r.key, m.title",
    )?;
    relation_refs(&mut stmt, target_path)
}

fn relation_refs(stmt: &mut rusqlite::Statement, key: &str) -> CoreResult<Vec<RelationRef>> {
    let rows = stmt
        .query_map(params![key], |r| {
            Ok(RelationRef {
                path: r.get(0)?,
                title: r.get(1)?,
                key: r.get(2)?,
            })
        })?
        .filter_map(|r| super::ok_row_or_warn("note_relations", r))
        .collect();
    Ok(rows)
}

/// Both directions of a note's typed relations. The reciprocity contract in one
/// call; backs the `note_relations` command.
pub fn relations_for(db: &Connection, path: &str) -> CoreResult<NoteRelations> {
    Ok(NoteRelations {
        outgoing: outgoing_relations(db, path)?,
        incoming: incoming_relations(db, path)?,
    })
}

/// Roll up a numeric `property_key` over the notes `source_path` relates to via
/// `relation_key`. The rollup primitive: gather the numeric values from the
/// related (target) notes and aggregate with [`rollup`]. Index-only.
pub fn rollup_relation(
    db: &Connection,
    source_path: &str,
    relation_key: &str,
    property_key: &str,
    op: RollupOp,
) -> CoreResult<RollupResult> {
    // DISTINCT target guards against a value fanning out to a duplicate row;
    // the numeric filter drops targets whose property isn't a number.
    let mut stmt = db.prepare(
        "SELECT p.kind, p.value
         FROM (SELECT DISTINCT target_path FROM note_relations
               WHERE source_path = ?1 AND key = ?2) r
         JOIN note_properties p ON p.path = r.target_path
         WHERE p.key = ?3 AND p.kind = ?4",
    )?;
    let values: Vec<f64> = stmt
        .query_map(
            params![source_path, relation_key, property_key, KIND_NUMBER],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )?
        .filter_map(|r| super::ok_row_or_warn("note_properties", r))
        .filter_map(|(kind, value)| value_as_number(&kind, &value))
        .collect();

    Ok(RollupResult {
        op,
        count: values.len(),
        value: rollup(op, &values),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{schema, search};
    use crate::models::NoteSummary;

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

    // ── pure helpers ─────────────────────────────────────────────────────────

    #[test]
    fn encode_decode_round_trips_every_kind() {
        let cases = vec![
            PropertyValue::Text("hello".into()),
            PropertyValue::Number(Some(3.5)),
            PropertyValue::Number(None),
            PropertyValue::Checkbox(true),
            PropertyValue::Checkbox(false),
            PropertyValue::List(vec!["a".into(), "b".into()]),
            PropertyValue::List(vec![]),
        ];
        for value in cases {
            let (kind, encoded) = encode_value(&value);
            assert_eq!(decode_value(kind, &encoded), value, "round trip {value:?}");
        }
    }

    #[test]
    fn decode_degrades_corrupt_rows_to_text() {
        assert_eq!(
            decode_value(KIND_NUMBER, "not-a-number"),
            PropertyValue::Text("not-a-number".into())
        );
        assert_eq!(
            decode_value(KIND_LIST, "{not json"),
            PropertyValue::Text("{not json".into())
        );
        // An unknown kind is surfaced as text, never dropped.
        assert_eq!(
            decode_value("mystery", "x"),
            PropertyValue::Text("x".into())
        );
    }

    #[test]
    fn relation_target_title_unwraps_wikilinks_and_bare_titles() {
        assert_eq!(relation_target_title("[[Alpha]]").as_deref(), Some("Alpha"));
        assert_eq!(
            relation_target_title("  [[ Spaced ]] ").as_deref(),
            Some("Spaced")
        );
        // A bare title is a candidate too.
        assert_eq!(relation_target_title("Beta").as_deref(), Some("Beta"));
        assert_eq!(relation_target_title("   "), None);
        assert_eq!(relation_target_title("[[]]"), None);
    }

    #[test]
    fn stored_candidates_only_from_text_and_list() {
        assert_eq!(
            stored_relation_candidates(KIND_TEXT, "[[Alpha]]"),
            vec!["Alpha".to_string()]
        );
        assert_eq!(
            stored_relation_candidates(KIND_LIST, r#"["[[Alpha]]","Beta","  "]"#),
            vec!["Alpha".to_string(), "Beta".to_string()]
        );
        // Numbers/checkboxes never form relations.
        assert!(stored_relation_candidates(KIND_NUMBER, "42").is_empty());
        assert!(stored_relation_candidates(KIND_CHECKBOX, "true").is_empty());
    }

    #[test]
    fn rollup_aggregations_and_empty_behaviour() {
        let v = vec![2.0, 4.0, 6.0];
        assert_eq!(rollup(RollupOp::Count, &v), Some(3.0));
        assert_eq!(rollup(RollupOp::Sum, &v), Some(12.0));
        assert_eq!(rollup(RollupOp::Avg, &v), Some(4.0));
        assert_eq!(rollup(RollupOp::Min, &v), Some(2.0));
        assert_eq!(rollup(RollupOp::Max, &v), Some(6.0));

        // Empty: Count/Sum defined, Avg/Min/Max undefined.
        assert_eq!(rollup(RollupOp::Count, &[]), Some(0.0));
        assert_eq!(rollup(RollupOp::Sum, &[]), Some(0.0));
        assert_eq!(rollup(RollupOp::Avg, &[]), None);
        assert_eq!(rollup(RollupOp::Min, &[]), None);
        assert_eq!(rollup(RollupOp::Max, &[]), None);
    }

    #[test]
    fn value_as_number_only_for_number_kind() {
        assert_eq!(value_as_number(KIND_NUMBER, "3.5"), Some(3.5));
        assert_eq!(value_as_number(KIND_NUMBER, "nope"), None);
        assert_eq!(value_as_number(KIND_TEXT, "3.5"), None);
    }

    // ── population + queries ────────────────────────────────────────────────

    /// Index a note with the given typed properties (also inserts note_meta).
    fn index_with_props(db: &Connection, path: &str, title: &str, props: &[(&str, PropertyValue)]) {
        let entries: Vec<NotePropertyEntry> = props
            .iter()
            .map(|(k, v)| NotePropertyEntry {
                key: (*k).to_string(),
                value: v.clone(),
            })
            .collect();
        // A minimal body indexes note_meta; then attach the typed properties.
        search::index_note(db, &summary(path, title), "body").unwrap();
        index_properties(db, path, &entries).unwrap();
    }

    #[test]
    fn properties_round_trip_through_the_index() {
        let (_tmp, db) = mem_db();
        index_with_props(
            &db,
            "a.md",
            "A",
            &[
                ("status", PropertyValue::Text("draft".into())),
                ("rating", PropertyValue::Number(Some(4.0))),
                ("done", PropertyValue::Checkbox(false)),
            ],
        );
        let props = properties_for(&db, "a.md").unwrap();
        assert_eq!(props.len(), 3);
        assert_eq!(props[0].key, "status");
        assert_eq!(props[1].value, PropertyValue::Number(Some(4.0)));

        // Re-indexing replaces (no duplicates, no stale keys).
        index_with_props(
            &db,
            "a.md",
            "A",
            &[("status", PropertyValue::Text("done".into()))],
        );
        let props = properties_for(&db, "a.md").unwrap();
        assert_eq!(props.len(), 1);
        assert_eq!(props[0].value, PropertyValue::Text("done".into()));
    }

    #[test]
    fn relation_resolves_wikilink_and_is_reciprocal() {
        let (_tmp, db) = mem_db();
        // Target must exist in note_meta to resolve.
        search::index_note(&db, &summary("Project.md", "Project"), "body").unwrap();
        index_with_props(
            &db,
            "Task.md",
            "Task",
            &[("project", PropertyValue::Text("[[Project]]".into()))],
        );

        // Outgoing on the source, incoming (reciprocal) on the target.
        let out = outgoing_relations(&db, "Task.md").unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(
            (out[0].path.as_str(), out[0].key.as_str()),
            ("Project.md", "project")
        );

        let inc = incoming_relations(&db, "Project.md").unwrap();
        assert_eq!(inc.len(), 1);
        assert_eq!(inc[0].path, "Task.md");

        // The combined view exposes both directions.
        let rel = relations_for(&db, "Project.md").unwrap();
        assert!(rel.outgoing.is_empty());
        assert_eq!(rel.incoming.len(), 1);
    }

    #[test]
    fn bare_title_and_list_values_form_relations_case_insensitively() {
        let (_tmp, db) = mem_db();
        search::index_note(&db, &summary("Alpha.md", "Alpha"), "b").unwrap();
        search::index_note(&db, &summary("Beta.md", "Beta"), "b").unwrap();
        index_with_props(
            &db,
            "Hub.md",
            "Hub",
            &[
                // Bare title (no brackets), different casing → still resolves.
                ("lead", PropertyValue::Text("alpha".into())),
                // List → one relation per resolvable element; "Ghost" resolves to nothing.
                (
                    "members",
                    PropertyValue::List(vec!["[[Beta]]".into(), "Ghost".into()]),
                ),
            ],
        );
        let mut targets: Vec<String> = outgoing_relations(&db, "Hub.md")
            .unwrap()
            .into_iter()
            .map(|r| r.path)
            .collect();
        targets.sort();
        assert_eq!(targets, vec!["Alpha.md".to_string(), "Beta.md".to_string()]);
    }

    #[test]
    fn non_resolving_and_numeric_values_make_no_relation() {
        let (_tmp, db) = mem_db();
        index_with_props(
            &db,
            "a.md",
            "A",
            &[
                ("who", PropertyValue::Text("Nobody Here".into())),
                ("count", PropertyValue::Number(Some(7.0))),
            ],
        );
        assert!(outgoing_relations(&db, "a.md").unwrap().is_empty());
    }

    #[test]
    fn self_relation_is_not_recorded() {
        let (_tmp, db) = mem_db();
        index_with_props(
            &db,
            "Self.md",
            "Self",
            &[("mirror", PropertyValue::Text("[[Self]]".into()))],
        );
        assert!(outgoing_relations(&db, "Self.md").unwrap().is_empty());
    }

    #[test]
    fn remove_clears_properties_and_relations_both_directions() {
        let (_tmp, db) = mem_db();
        search::index_note(&db, &summary("Project.md", "Project"), "b").unwrap();
        index_with_props(
            &db,
            "Task.md",
            "Task",
            &[("project", PropertyValue::Text("[[Project]]".into()))],
        );

        // Removing the TARGET clears the incoming row that pointed at it.
        remove_properties(&db, "Project.md").unwrap();
        assert!(outgoing_relations(&db, "Task.md").unwrap().is_empty());

        // Removing the SOURCE clears its own props/relations.
        remove_properties(&db, "Task.md").unwrap();
        assert!(properties_for(&db, "Task.md").unwrap().is_empty());
    }

    #[test]
    fn resolve_all_relations_fixes_build_order_dependence() {
        let (_tmp, db) = mem_db();
        // Source indexed BEFORE its target: per-note resolution can't see the
        // target yet, so no relation row exists at this point.
        index_with_props(
            &db,
            "Task.md",
            "Task",
            &[("project", PropertyValue::Text("[[Project]]".into()))],
        );
        assert!(outgoing_relations(&db, "Task.md").unwrap().is_empty());

        // Target appears later; the post-pass a full build runs re-resolves all.
        search::index_note(&db, &summary("Project.md", "Project"), "b").unwrap();
        resolve_all_relations(&db).unwrap();

        let out = outgoing_relations(&db, "Task.md").unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "Project.md");
    }

    #[test]
    fn title_collision_fans_out_like_the_link_graph() {
        let (_tmp, db) = mem_db();
        // Two notes share the title "Doc": a relation to "Doc" reaches both.
        search::index_note(&db, &summary("a/Doc.md", "Doc"), "b").unwrap();
        search::index_note(&db, &summary("b/Doc.md", "Doc"), "b").unwrap();
        index_with_props(
            &db,
            "Src.md",
            "Src",
            &[("ref", PropertyValue::Text("[[Doc]]".into()))],
        );
        assert_eq!(outgoing_relations(&db, "Src.md").unwrap().len(), 2);
    }

    #[test]
    fn rollup_sums_numeric_property_across_related_notes() {
        let (_tmp, db) = mem_db();
        // Three products with a price; an order relates to two of them.
        index_with_props(
            &db,
            "P1.md",
            "P1",
            &[("price", PropertyValue::Number(Some(10.0)))],
        );
        index_with_props(
            &db,
            "P2.md",
            "P2",
            &[("price", PropertyValue::Number(Some(5.0)))],
        );
        index_with_props(
            &db,
            "P3.md",
            "P3",
            &[("price", PropertyValue::Number(Some(99.0)))],
        );
        index_with_props(
            &db,
            "Order.md",
            "Order",
            &[(
                "items",
                PropertyValue::List(vec!["[[P1]]".into(), "[[P2]]".into()]),
            )],
        );

        let sum = rollup_relation(&db, "Order.md", "items", "price", RollupOp::Sum).unwrap();
        assert_eq!(sum.count, 2);
        assert_eq!(sum.value, Some(15.0));

        let avg = rollup_relation(&db, "Order.md", "items", "price", RollupOp::Avg).unwrap();
        assert_eq!(avg.value, Some(7.5));
        let max = rollup_relation(&db, "Order.md", "items", "price", RollupOp::Max).unwrap();
        assert_eq!(max.value, Some(10.0));

        // A property that no related note carries → empty aggregate.
        let none = rollup_relation(&db, "Order.md", "items", "weight", RollupOp::Avg).unwrap();
        assert_eq!(none.count, 0);
        assert_eq!(none.value, None);
    }
}
