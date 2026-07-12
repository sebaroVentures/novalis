//! First-class block references: stable, content-independent block IDs and the
//! `((^id))` reference graph.
//!
//! A block is tagged by appending a ` ^<id>` marker (base36) to the end of its
//! line in the Markdown — e.g. `A key point. ^k3f9qz`. The id is random and
//! carries no meaning, so it SURVIVES heading renames and text edits: a
//! reference is keyed on the id, never on the heading text or the block's
//! content. (Contrast `![[Note#Heading]]` section links, keyed on the heading
//! TEXT, which break silently when the heading is renamed.)
//!
//! Both tables live in the disposable index cache (`schema.rs`, v9) and are
//! rebuilt from the Markdown on every `index_note`, so they can never drift
//! from what is on disk:
//!   - `block_index` — one row per tagged block (`block_id → note + text`);
//!   - `block_refs` — one row per `((^id))` reference (`source_path → id`),
//!     the backlink half.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use rusqlite::{params, Connection};

use crate::error::CoreResult;
use crate::models::{BlockHit, BlockResolution, LinkMatch, LinkReference};

/// A tagged block extracted from a note body: its stable id plus the block's
/// text (marker stripped) and the char span the text occupies in the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockEntry {
    pub id: String,
    /// Char offset (into the frontmatter-stripped body) of the block text start.
    pub char_start: usize,
    /// Char offset (exclusive) of the block text end — before the ` ^id` marker.
    pub char_end: usize,
    /// The block's display text, with the trailing ` ^id` marker removed.
    pub text: String,
}

/// A trailing ` ^<id>` block-id marker at the end of a line. The leading
/// whitespace is required so a bare `^` mid-line (e.g. inside `$e^{x}$` math,
/// which is `0^{` — no space) is never mistaken for a marker. Ids are base36
/// so they never need Markdown escaping (round-trip stays trivial).
fn marker_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s\^([a-z0-9]{4,32})\s*$").unwrap())
}

/// A `((^id))` block reference. The `^` sigil (mirroring the marker) keeps a
/// reference unambiguous against ordinary `((parenthetical))` prose.
fn ref_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\(\(\^([a-z0-9]{4,32})\)\)").unwrap())
}

/// Extract every tagged block from a note body, in document order. The first
/// occurrence of a given id wins (a duplicated id — e.g. from a copy/paste —
/// is not indexed twice, so a reference resolves to a single block). Markers
/// inside fenced code (```` ``` ````/`~~~`) are ignored, mirroring the task and
/// section scanners.
pub fn extract_block_ids(body: &str) -> Vec<BlockEntry> {
    let re = marker_re();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut in_fence = false;
    // Char offset of the current line's first char within `body`.
    let mut line_start = 0usize;

    for line in body.split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        let content = content.strip_suffix('\r').unwrap_or(content);
        let line_chars = line.chars().count();

        let trimmed = content.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            line_start += line_chars;
            continue;
        }
        if in_fence {
            line_start += line_chars;
            continue;
        }

        if let Some(caps) = re.captures(content) {
            let m = caps.get(0).unwrap();
            let id = caps.get(1).unwrap().as_str().to_string();
            // Text is everything before the marker match, trailing space trimmed.
            let text_bytes = &content[..m.start()];
            let text = text_bytes.trim_end().to_string();
            if !text.is_empty() && seen.insert(id.clone()) {
                let start = line_start;
                let end = start + text.chars().count();
                out.push(BlockEntry {
                    id,
                    char_start: start,
                    char_end: end,
                    text,
                });
            }
        }
        line_start += line_chars;
    }
    out
}

/// Extract the unique `((^id))` reference targets from a note body, in order.
pub fn extract_block_refs(body: &str) -> Vec<String> {
    let re = ref_re();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for caps in re.captures_iter(body) {
        let id = caps.get(1).unwrap().as_str().to_string();
        if seen.insert(id.clone()) {
            out.push(id);
        }
    }
    out
}

/// Replace the block index rows for a note.
pub fn index_blocks(db: &Connection, note_path: &str, blocks: &[BlockEntry]) -> CoreResult<()> {
    db.execute(
        "DELETE FROM block_index WHERE note_path = ?1",
        params![note_path],
    )?;
    let mut stmt = db.prepare(
        "INSERT INTO block_index (note_path, block_id, char_start, char_end, text)
         VALUES (?1, ?2, ?3, ?4, ?5)",
    )?;
    for b in blocks {
        stmt.execute(params![
            note_path,
            b.id,
            b.char_start as i64,
            b.char_end as i64,
            b.text
        ])?;
    }
    Ok(())
}

/// Replace the outgoing block references recorded for a note.
pub fn index_block_refs(db: &Connection, source_path: &str, ids: &[String]) -> CoreResult<()> {
    db.execute(
        "DELETE FROM block_refs WHERE source_path = ?1",
        params![source_path],
    )?;
    let mut stmt = db.prepare("INSERT INTO block_refs (source_path, block_id) VALUES (?1, ?2)")?;
    for id in ids {
        stmt.execute(params![source_path, id])?;
    }
    Ok(())
}

/// Clear both block tables for a note (used on delete/full-rebuild pruning).
pub fn remove_blocks(db: &Connection, note_path: &str) -> CoreResult<()> {
    db.execute(
        "DELETE FROM block_index WHERE note_path = ?1",
        params![note_path],
    )?;
    db.execute(
        "DELETE FROM block_refs WHERE source_path = ?1",
        params![note_path],
    )?;
    Ok(())
}

/// Tagged blocks whose text contains `query` (case-insensitive substring),
/// most-recently-modified note first, for the `((` reference autocomplete. An
/// empty query returns the most recent tagged blocks so the popover is useful
/// before anything is typed.
pub fn search_blocks(db: &Connection, query: &str, limit: usize) -> CoreResult<Vec<BlockHit>> {
    let pattern = format!("%{}%", crate::index::search::escape_like(query.trim()));
    let mut stmt = db.prepare(
        "SELECT b.block_id, b.note_path, m.title, b.text
         FROM block_index b
         JOIN note_meta m ON m.path = b.note_path
         WHERE b.text LIKE ?1 ESCAPE '\\'
         ORDER BY m.modified DESC
         LIMIT ?2",
    )?;
    let hits = stmt
        .query_map(params![pattern, limit as i64], |r| {
            Ok(BlockHit {
                id: r.get(0)?,
                note_path: r.get(1)?,
                note_title: r.get(2)?,
                text: r.get(3)?,
            })
        })?
        .filter_map(|r| crate::index::ok_row_or_warn("block_index", r))
        .collect();
    Ok(hits)
}

/// Resolve a `((^id))` reference to the block it names: its note (path + title)
/// and text, straight from the index (no disk read). Returns
/// [`BlockResolution`] with `found=false` when the id is unknown — a dangling
/// reference (its block was deleted) renders as "missing" rather than erroring.
pub fn resolve_block(db: &Connection, block_id: &str) -> CoreResult<BlockResolution> {
    let hit: Option<(String, String, String)> = db
        .query_row(
            "SELECT b.note_path, m.title, b.text
             FROM block_index b
             JOIN note_meta m ON m.path = b.note_path
             WHERE b.block_id = ?1
             LIMIT 1",
            params![block_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();

    Ok(match hit {
        Some((path, title, text)) => BlockResolution {
            found: true,
            note_path: Some(path),
            note_title: Some(title),
            text: Some(text),
        },
        None => BlockResolution {
            found: false,
            note_path: None,
            note_title: None,
            text: None,
        },
    })
}

/// Notes that reference the block `block_id` via `((^id))`, each with the
/// line(s) where the reference appears — the block-level backlinks. A note
/// known to reference is always included even if no snippet could be extracted
/// (e.g. an online-only file).
pub fn block_backlinks(
    db: &Connection,
    vault: &Path,
    block_id: &str,
) -> CoreResult<Vec<LinkReference>> {
    let mut stmt = db.prepare(
        "SELECT m.path, m.title, m.folder, m.modified, m.cloud_only
         FROM note_meta m
         JOIN block_refs r ON r.source_path = m.path
         WHERE r.block_id = ?1
         GROUP BY m.path
         ORDER BY m.modified DESC",
    )?;
    let rows = stmt
        .query_map(params![block_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i32>(4)? != 0,
            ))
        })?
        .filter_map(|r| crate::index::ok_row_or_warn("note_meta", r))
        .collect::<Vec<_>>();

    let needle = format!("((^{block_id}))");
    let mut out = Vec::with_capacity(rows.len());
    for (path, title, folder, modified, cloud_only) in rows {
        let matches = if cloud_only {
            Vec::new()
        } else {
            crate::vault::fs::read_note(vault, &path)
                .ok()
                .map(|n| ref_match_lines(&n.content, &needle))
                .unwrap_or_default()
        };
        out.push(LinkReference {
            path,
            title,
            folder,
            modified,
            matches,
        });
    }
    Ok(out)
}

/// Body lines (1-based, raw-file coordinates) containing the `((^id))` reference.
fn ref_match_lines(content: &str, needle: &str) -> Vec<LinkMatch> {
    let mut out = Vec::new();
    for (i, line) in content.lines().enumerate() {
        if line.contains(needle) {
            let trimmed = line.trim();
            let snippet = if trimmed.chars().count() > 200 {
                let head: String = trimmed.chars().take(200).collect();
                format!("{head}…")
            } else {
                trimmed.to_string()
            };
            out.push(LinkMatch {
                line: i + 1,
                snippet,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{schema, search};
    use crate::models::NoteSummary;

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
    fn extract_block_ids_finds_trailing_markers() {
        let body = "# Heading ^head01\n\nA key point. ^k3f9qz\n\n- item one ^li0001\n";
        let blocks = extract_block_ids(body);
        let ids: Vec<&str> = blocks.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, vec!["head01", "k3f9qz", "li0001"]);
        // Marker is stripped from the stored text.
        assert_eq!(blocks[1].text, "A key point.");
        // Char span points at the block text within the body.
        let slice: String = body
            .chars()
            .skip(blocks[1].char_start)
            .take(blocks[1].char_end - blocks[1].char_start)
            .collect();
        assert_eq!(slice, "A key point.");
    }

    #[test]
    fn extract_block_ids_ignores_fenced_code_and_bare_carets() {
        // A caret inside math or code must not be read as a marker; only a
        // space-prefixed trailing id counts.
        let body = "```\ncode ^nope01\n```\nEuler $e^{i}$ prose\nreal one ^real01\n";
        let ids: Vec<String> = extract_block_ids(body).into_iter().map(|b| b.id).collect();
        assert_eq!(ids, vec!["real01"]);
    }

    #[test]
    fn extract_block_ids_dedups_by_id() {
        let body = "first ^dup000\nsecond ^dup000\n";
        assert_eq!(extract_block_ids(body).len(), 1);
    }

    #[test]
    fn extract_block_refs_only_matches_caret_form() {
        // `((^id))` is a reference; ordinary `((prose))` is not.
        let body = "see ((^k3f9qz)) and ((not a ref)) and ((^head01)) twice ((^k3f9qz))";
        assert_eq!(extract_block_refs(body), vec!["k3f9qz", "head01"]);
    }

    #[test]
    fn resolve_block_returns_note_and_text() {
        let dir = tempfile::tempdir().unwrap();
        let db = schema::open_db(&dir.path().join("notes.db")).unwrap();
        search::index_note(
            &db,
            &summary("notes/src.md", "Source"),
            "The thesis statement. ^thes01\n",
        )
        .unwrap();

        let hit = resolve_block(&db, "thes01").unwrap();
        assert!(hit.found);
        assert_eq!(hit.note_path.as_deref(), Some("notes/src.md"));
        assert_eq!(hit.note_title.as_deref(), Some("Source"));
        assert_eq!(hit.text.as_deref(), Some("The thesis statement."));

        // Unknown id → missing, not an error.
        let miss = resolve_block(&db, "zzzzzz").unwrap();
        assert!(!miss.found);
        assert!(miss.note_path.is_none());
    }

    #[test]
    fn block_id_survives_heading_rename() {
        // The reference is keyed on the id, not the heading text: rename the
        // heading and re-index; the same `((^id))` still resolves to the block.
        let dir = tempfile::tempdir().unwrap();
        let db = schema::open_db(&dir.path().join("notes.db")).unwrap();

        search::index_note(
            &db,
            &summary("src.md", "Src"),
            "## Old Heading\n\nThe stable claim. ^stbl01\n",
        )
        .unwrap();
        let before = resolve_block(&db, "stbl01").unwrap();
        assert_eq!(before.text.as_deref(), Some("The stable claim."));

        // Heading renamed; the block text is unchanged and keeps its id.
        search::index_note(
            &db,
            &summary("src.md", "Src"),
            "## A Completely Different Heading\n\nThe stable claim. ^stbl01\n",
        )
        .unwrap();
        let after = resolve_block(&db, "stbl01").unwrap();
        assert!(after.found, "reference broke on heading rename");
        assert_eq!(after.note_path.as_deref(), Some("src.md"));
    }

    #[test]
    fn block_backlinks_report_referencing_notes_and_lines() {
        let dir = tempfile::tempdir().unwrap();
        let db = schema::open_db(&dir.path().join("notes.db")).unwrap();

        // Only the REFERENCING note needs to exist on disk (block_backlinks reads
        // it to extract the context snippet); the target is index-only.
        std::fs::write(
            dir.path().join("ref.md"),
            "Referencing here: ((^tgt001)) inline.\n",
        )
        .unwrap();
        search::index_note(&db, &summary("src.md", "Src"), "Target block. ^tgt001\n").unwrap();
        search::index_note(
            &db,
            &summary("ref.md", "Ref"),
            "Referencing here: ((^tgt001)) inline.\n",
        )
        .unwrap();

        let backs = block_backlinks(&db, dir.path(), "tgt001").unwrap();
        assert_eq!(backs.len(), 1);
        assert_eq!(backs[0].path, "ref.md");
        assert_eq!(backs[0].matches.len(), 1);
        assert_eq!(backs[0].matches[0].line, 1);
    }
}
