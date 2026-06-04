//! `[[wikilink]]` graph: extraction, storage, backlinks, and unlinked mentions.
//!
//! Backlinks and unlinked mentions return [`LinkReference`]s carrying the actual
//! lines where a note links to or names a target, so the editor can show the
//! surrounding context (not just a bare list of notes).

use std::path::Path;

use regex::Regex;
use rusqlite::{params, Connection};

use crate::error::CoreResult;
use crate::models::{GraphEdge, GraphNode, LinkMatch, LinkReference, NoteGraph};

/// The `[[target]]` pattern. Compiled once per query and reused across lines.
fn wiki_regex() -> Regex {
    Regex::new(r"\[\[([^\[\]]+)\]\]").unwrap()
}

/// A case-insensitive, word-boundary matcher for a bare (un-bracketed) mention
/// of `title`. `None` for an empty title.
fn mention_regex(title: &str) -> Option<Regex> {
    let escaped = regex::escape(title.trim());
    if escaped.is_empty() {
        return None;
    }
    Regex::new(&format!(r"(?i)\b{escaped}\b")).ok()
}

/// Extract unique `[[wiki-link]]` targets from a note body, preserving order.
pub fn extract_wiki_links(body: &str) -> Vec<String> {
    let re = wiki_regex();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for caps in re.captures_iter(body) {
        let target = caps.get(1).unwrap().as_str().trim().to_string();
        if target.is_empty() {
            continue;
        }
        if seen.insert(target.clone()) {
            out.push(target);
        }
    }
    out
}

/// Replace the outgoing links recorded for a note.
pub fn index_links(db: &Connection, source_path: &str, targets: &[String]) -> CoreResult<()> {
    db.execute(
        "DELETE FROM links WHERE source_path = ?1",
        params![source_path],
    )?;
    let mut stmt = db.prepare("INSERT INTO links (source_path, target_title) VALUES (?1, ?2)")?;
    for target in targets {
        stmt.execute(params![source_path, target])?;
    }
    Ok(())
}

/// Notes that link to `title` (case-insensitive) via `[[title]]`, each with the
/// line(s) where the link appears. A note known to link is always included even
/// if no snippet could be extracted (e.g. an online-only file).
pub fn backlinks(db: &Connection, vault: &Path, title: &str) -> CoreResult<Vec<LinkReference>> {
    let mut stmt = db.prepare(
        "SELECT m.path, m.title, m.folder, m.modified, m.cloud_only
         FROM note_meta m
         JOIN links l ON l.source_path = m.path
         WHERE lower(l.target_title) = lower(?1)
         GROUP BY m.path
         ORDER BY m.modified DESC",
    )?;
    let rows = collect_rows(&mut stmt, params![title])?;

    let wiki = wiki_regex();
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let matches = body_for(vault, &row)
            .map(|body| backlink_match_lines(&body, &wiki, title))
            .unwrap_or_default();
        out.push(row.into_reference(matches));
    }
    Ok(out)
}

/// Notes whose content mentions `title` but do not yet link to it (excluding the
/// note itself), each with the line(s) of the bare mention. Notes the FTS
/// matched only inside frontmatter or an existing `[[…]]` are dropped.
pub fn unlinked_mentions(
    db: &Connection,
    vault: &Path,
    title: &str,
    self_path: &str,
) -> CoreResult<Vec<LinkReference>> {
    let Some(mention) = mention_regex(title) else {
        return Ok(Vec::new());
    };
    let fts_query = title.replace('"', "\"\"");
    let mut stmt = db.prepare(
        "SELECT m.path, m.title, m.folder, m.modified, m.cloud_only
         FROM note_meta m
         JOIN notes_fts f ON f.path = m.path
         WHERE notes_fts MATCH ?1
           AND m.path != ?2
           AND m.path NOT IN (
             SELECT source_path FROM links WHERE lower(target_title) = lower(?3)
           )
         ORDER BY m.modified DESC
         LIMIT 50",
    )?;
    let rows = collect_rows(
        &mut stmt,
        params![format!("\"{}\"", fts_query), self_path, title],
    )?;

    let wiki = wiki_regex();
    let mut out = Vec::new();
    for row in rows {
        let Some(body) = body_for(vault, &row) else {
            continue;
        };
        let matches = mention_match_lines(&body, &wiki, &mention);
        if matches.is_empty() {
            continue;
        }
        out.push(row.into_reference(matches));
    }
    Ok(out)
}

/// The 1-hop link neighborhood of `path`: outgoing links (resolved to existing
/// notes by title) and incoming links (notes that link to this note's title).
/// Index-only (no disk reads); unresolved/missing targets are omitted.
pub fn note_graph(db: &Connection, path: &str) -> CoreResult<NoteGraph> {
    let center: Option<(String, String)> = db
        .query_row(
            "SELECT path, title FROM note_meta WHERE path = ?1",
            params![path],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    let Some((center_path, center_title)) = center else {
        return Ok(NoteGraph {
            center: path.to_string(),
            nodes: Vec::new(),
            edges: Vec::new(),
        });
    };

    let mut seen = std::collections::HashSet::new();
    let mut nodes = vec![GraphNode {
        path: center_path.clone(),
        title: center_title.clone(),
    }];
    seen.insert(center_path.clone());
    let mut edges = Vec::new();

    // Outgoing: this note's `[[targets]]` resolved to existing notes by title.
    let mut out = db.prepare(
        "SELECT DISTINCT nm.path, nm.title
         FROM links l JOIN note_meta nm ON lower(nm.title) = lower(l.target_title)
         WHERE l.source_path = ?1 AND nm.path != ?1
         ORDER BY nm.title",
    )?;
    let outgoing: Vec<(String, String)> = out
        .query_map(params![center_path], |r| Ok((r.get(0)?, r.get(1)?)))?
        .filter_map(|r| r.ok())
        .collect();
    for (p, t) in outgoing {
        if seen.insert(p.clone()) {
            nodes.push(GraphNode {
                path: p.clone(),
                title: t,
            });
        }
        edges.push(GraphEdge {
            source: center_path.clone(),
            target: p,
        });
    }

    // Incoming: notes that link to this note's title.
    let mut inc = db.prepare(
        "SELECT DISTINCT nm.path, nm.title
         FROM note_meta nm JOIN links l ON l.source_path = nm.path
         WHERE lower(l.target_title) = lower(?1) AND nm.path != ?2
         ORDER BY nm.title",
    )?;
    let incoming: Vec<(String, String)> = inc
        .query_map(params![center_title, center_path], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();
    for (p, t) in incoming {
        if seen.insert(p.clone()) {
            nodes.push(GraphNode {
                path: p.clone(),
                title: t,
            });
        }
        edges.push(GraphEdge {
            source: p,
            target: center_path.clone(),
        });
    }

    Ok(NoteGraph {
        center: center_path,
        nodes,
        edges,
    })
}

/// Result of bracketing a bare mention on a single line.
pub(crate) enum MentionLink {
    /// The line, rewritten with the first bare mention wrapped in `[[ ]]`.
    Replaced(String),
    /// The title is already linked on this line — nothing to do.
    AlreadyLinked,
    /// No occurrence of the title on this line (the note changed since load).
    NotFound,
}

/// Wrap the first bare (un-bracketed) occurrence of `title` on `line` in
/// `[[ ]]`, preserving the original casing of the matched text.
pub(crate) fn link_bare_mention_in_line(line: &str, title: &str) -> MentionLink {
    let Some(mention) = mention_regex(title) else {
        return MentionLink::NotFound;
    };
    let wiki = wiki_regex();
    let bracket_spans: Vec<(usize, usize)> =
        wiki.find_iter(line).map(|m| (m.start(), m.end())).collect();
    let in_bracket = |pos: usize| bracket_spans.iter().any(|(s, e)| pos >= *s && pos < *e);

    if let Some(m) = mention.find_iter(line).find(|m| !in_bracket(m.start())) {
        let mut out = String::with_capacity(line.len() + 4);
        out.push_str(&line[..m.start()]);
        out.push_str("[[");
        out.push_str(&line[m.start()..m.end()]);
        out.push_str("]]");
        out.push_str(&line[m.end()..]);
        return MentionLink::Replaced(out);
    }

    // Already-bracketed occurrence of this exact title → idempotent no-op.
    let already = bracket_spans.iter().any(|(s, e)| {
        wiki.captures(&line[*s..*e])
            .and_then(|c| c.get(1))
            .map(|g| g.as_str().trim().eq_ignore_ascii_case(title.trim()))
            .unwrap_or(false)
    });
    if already {
        MentionLink::AlreadyLinked
    } else {
        MentionLink::NotFound
    }
}

// ── internals ────────────────────────────────────────────────────────────────

/// A `note_meta` row selected by the backlink/mention queries.
struct LinkRow {
    path: String,
    title: String,
    folder: String,
    modified: String,
    cloud_only: bool,
}

impl LinkRow {
    fn into_reference(self, matches: Vec<LinkMatch>) -> LinkReference {
        LinkReference {
            path: self.path,
            title: self.title,
            folder: self.folder,
            modified: self.modified,
            matches,
        }
    }
}

fn collect_rows(
    stmt: &mut rusqlite::Statement,
    params: impl rusqlite::Params,
) -> CoreResult<Vec<LinkRow>> {
    let rows = stmt
        .query_map(params, |r| {
            Ok(LinkRow {
                path: r.get(0)?,
                title: r.get(1)?,
                folder: r.get(2)?,
                modified: r.get(3)?,
                cloud_only: r.get::<_, i32>(4)? != 0,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(rows)
}

/// Read a candidate note's raw content for snippet extraction. Skips online-only
/// cloud placeholders so opening the panel never triggers a network download.
fn body_for(vault: &Path, row: &LinkRow) -> Option<String> {
    if row.cloud_only {
        return None;
    }
    crate::vault::fs::read_note(vault, &row.path)
        .ok()
        .map(|n| n.content)
}

/// 0-based index of the first body line, skipping a leading YAML frontmatter
/// block (`---` … `---`). Returns 0 when there is no frontmatter.
fn body_start_line(lines: &[&str]) -> usize {
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return 0;
    }
    for (i, l) in lines.iter().enumerate().skip(1) {
        if l.trim_end() == "---" {
            return i + 1;
        }
    }
    0
}

/// Trim and cap a line for display as a snippet.
fn snippet_of(line: &str) -> String {
    const MAX: usize = 200;
    let trimmed = line.trim();
    if trimmed.chars().count() > MAX {
        let head: String = trimmed.chars().take(MAX).collect();
        format!("{head}…")
    } else {
        trimmed.to_string()
    }
}

/// Body lines (1-based, raw-file coordinates) containing a `[[wikilink]]` whose
/// target matches `title` (case-insensitive).
fn backlink_match_lines(content: &str, wiki: &Regex, title: &str) -> Vec<LinkMatch> {
    let lines: Vec<&str> = content.lines().collect();
    let start = body_start_line(&lines);
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate().skip(start) {
        let hit = wiki.captures_iter(line).any(|c| {
            c.get(1)
                .map(|m| m.as_str().trim().eq_ignore_ascii_case(title))
                .unwrap_or(false)
        });
        if hit {
            out.push(LinkMatch {
                line: i + 1,
                snippet: snippet_of(line),
            });
        }
    }
    out
}

/// Body lines (1-based, raw-file coordinates) with a bare (un-bracketed) mention
/// matched by `mention`.
fn mention_match_lines(content: &str, wiki: &Regex, mention: &Regex) -> Vec<LinkMatch> {
    let lines: Vec<&str> = content.lines().collect();
    let start = body_start_line(&lines);
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate().skip(start) {
        let bracket_spans: Vec<(usize, usize)> =
            wiki.find_iter(line).map(|m| (m.start(), m.end())).collect();
        let has_bare = mention.find_iter(line).any(|m| {
            !bracket_spans
                .iter()
                .any(|(s, e)| m.start() >= *s && m.start() < *e)
        });
        if has_bare {
            out.push(LinkMatch {
                line: i + 1,
                snippet: snippet_of(line),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_wiki_links_finds_unique_targets_in_order() {
        let body = "See [[Alpha]] and [[Beta Note]], then [[Alpha]] again.";
        assert_eq!(
            extract_wiki_links(body),
            vec!["Alpha".to_string(), "Beta Note".to_string()]
        );
    }

    #[test]
    fn extract_wiki_links_trims_and_ignores_empty() {
        let body = "[[  Spaced  ]] and [[]] empty";
        assert_eq!(extract_wiki_links(body), vec!["Spaced".to_string()]);
    }

    #[test]
    fn extract_wiki_links_none_when_absent() {
        assert!(extract_wiki_links("plain text, no links").is_empty());
    }

    #[test]
    fn backlink_match_lines_reports_linking_line_after_frontmatter() {
        let wiki = wiki_regex();
        let content = "---\ntitle: Source\n---\nintro line\nsee [[Target Note]] here\ntrailing";
        let matches = backlink_match_lines(content, &wiki, "target note");
        assert_eq!(matches.len(), 1);
        // Line 5 of the raw file (frontmatter is lines 1-3, body starts at 4).
        assert_eq!(matches[0].line, 5);
        assert_eq!(matches[0].snippet, "see [[Target Note]] here");
    }

    #[test]
    fn mention_match_lines_skips_already_bracketed_and_uses_word_boundary() {
        let wiki = wiki_regex();
        let mention = mention_regex("Cat").unwrap();
        // "Category" must NOT match (word boundary); the bracketed [[Cat]] is skipped.
        let content = "the Category grows\nI saw a Cat today\nlink [[Cat]] only";
        let matches = mention_match_lines(content, &wiki, &mention);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].line, 2);
        assert_eq!(matches[0].snippet, "I saw a Cat today");
    }

    #[test]
    fn link_bare_mention_wraps_first_bare_occurrence_only() {
        match link_bare_mention_in_line("see Foo and [[Foo]] and Foo", "Foo") {
            MentionLink::Replaced(s) => assert_eq!(s, "see [[Foo]] and [[Foo]] and Foo"),
            _ => panic!("expected a replacement"),
        }
    }

    #[test]
    fn link_bare_mention_preserves_original_casing() {
        match link_bare_mention_in_line("I love recipes here", "Recipes") {
            MentionLink::Replaced(s) => assert_eq!(s, "I love [[recipes]] here"),
            _ => panic!("expected a replacement"),
        }
    }

    #[test]
    fn link_bare_mention_idempotent_when_already_linked() {
        assert!(matches!(
            link_bare_mention_in_line("already [[Foo]] linked", "Foo"),
            MentionLink::AlreadyLinked
        ));
    }

    #[test]
    fn link_bare_mention_not_found_when_absent() {
        assert!(matches!(
            link_bare_mention_in_line("nothing relevant here", "Foo"),
            MentionLink::NotFound
        ));
    }

    #[test]
    fn note_graph_collects_incoming_and_outgoing_neighbors() {
        use crate::index::{schema, search};
        use crate::models::NoteSummary;

        let dir = std::env::temp_dir().join(format!("novalis-graph-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = schema::open_db(&dir.join("notes.db")).unwrap();

        let summary = |path: &str, title: &str| NoteSummary {
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
        };

        // Hub → Spoke (outgoing); Inbound → Hub (incoming).
        search::index_note(&db, &summary("Hub.md", "Hub"), "see [[Spoke]]").unwrap();
        search::index_note(&db, &summary("Spoke.md", "Spoke"), "nothing here").unwrap();
        search::index_note(&db, &summary("Inbound.md", "Inbound"), "see [[Hub]]").unwrap();

        let g = note_graph(&db, "Hub.md").unwrap();
        assert_eq!(g.center, "Hub.md");
        let mut paths: Vec<&str> = g.nodes.iter().map(|n| n.path.as_str()).collect();
        paths.sort();
        assert_eq!(paths, vec!["Hub.md", "Inbound.md", "Spoke.md"]);
        assert!(g
            .edges
            .iter()
            .any(|e| e.source == "Hub.md" && e.target == "Spoke.md"));
        assert!(g
            .edges
            .iter()
            .any(|e| e.source == "Inbound.md" && e.target == "Hub.md"));

        std::fs::remove_dir_all(&dir).ok();
    }
}
