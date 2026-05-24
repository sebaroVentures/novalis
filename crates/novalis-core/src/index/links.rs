//! `[[wikilink]]` graph: extraction, storage, backlinks, and unlinked mentions.

use rusqlite::{params, Connection};

use crate::error::CoreResult;
use crate::models::NoteSummary;

/// Extract unique `[[wiki-link]]` targets from a note body, preserving order.
pub fn extract_wiki_links(body: &str) -> Vec<String> {
    let re = regex::Regex::new(r"\[\[([^\[\]]+)\]\]").unwrap();
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

/// Notes that link to `title` (case-insensitive) via `[[title]]`.
pub fn backlinks(db: &Connection, title: &str) -> CoreResult<Vec<NoteSummary>> {
    let mut stmt = db.prepare(
        "SELECT m.path, m.title, m.folder, m.tags, m.created, m.modified, m.pinned, m.word_count, m.task_total, m.task_completed
         FROM note_meta m
         JOIN links l ON l.source_path = m.path
         WHERE lower(l.target_title) = lower(?1)
         GROUP BY m.path
         ORDER BY m.modified DESC",
    )?;
    crate::index::rows_to_summaries(&mut stmt, params![title])
}

/// Notes whose content mentions `title` but do not yet link to it (excluding
/// the note itself).
pub fn unlinked_mentions(
    db: &Connection,
    title: &str,
    self_path: &str,
) -> CoreResult<Vec<NoteSummary>> {
    let fts_query = title.replace('"', "\"\"");
    let mut stmt = db.prepare(
        "SELECT m.path, m.title, m.folder, m.tags, m.created, m.modified, m.pinned, m.word_count, m.task_total, m.task_completed
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
    crate::index::rows_to_summaries(
        &mut stmt,
        params![format!("\"{}\"", fts_query), self_path, title],
    )
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
}
