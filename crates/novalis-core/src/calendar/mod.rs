//! Calendar service: own events live as markdown notes under `Calendar/` with
//! `type: event` frontmatter, so they sync as plain files like everything else.
//! Remote sources and `.ics` interchange are added in the source layer.

pub mod remote;
pub mod source;

use std::path::Path;

use rusqlite::Connection;
use serde_json::json;

use crate::change;
use crate::error::{CoreError, CoreResult};
use crate::index::events;
use crate::models::{CalendarEvent, EventInput, NoteFrontmatter};
use crate::vault::{frontmatter, fs as vault_fs};

fn build_frontmatter(input: &EventInput) -> NoteFrontmatter {
    let mut extra = serde_json::Map::new();
    extra.insert("type".into(), json!("event"));
    extra.insert("date".into(), json!(input.date));
    extra.insert("allDay".into(), json!(input.all_day));
    if let Some(t) = &input.start_time {
        extra.insert("startTime".into(), json!(t));
    }
    if let Some(t) = &input.end_time {
        extra.insert("endTime".into(), json!(t));
    }
    if let Some(r) = &input.rrule {
        extra.insert("rrule".into(), json!(r));
    }
    if let Some(l) = &input.location {
        extra.insert("location".into(), json!(l));
    }
    NoteFrontmatter {
        title: Some(input.title.clone()),
        extra: serde_json::Value::Object(extra),
        ..Default::default()
    }
}

fn sanitize(title: &str) -> String {
    let s: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    s.trim().to_string()
}

/// Create an own event as a new markdown note under `Calendar/`.
pub fn create_event(db: &Connection, vault: &Path, input: EventInput) -> CoreResult<CalendarEvent> {
    if input.title.trim().is_empty() {
        return Err(CoreError::BadRequest(
            "Event title must not be empty".to_string(),
        ));
    }
    let fm = build_frontmatter(&input);
    let content = frontmatter::serialize_frontmatter(&fm, "");

    let stem = {
        let s = sanitize(&input.title);
        if s.is_empty() {
            "Event".to_string()
        } else {
            s
        }
    };
    let mut rel = format!("Calendar/{stem}.md");
    let mut n = 2;
    while vault.join(&rel).exists() {
        rel = format!("Calendar/{stem} {n}.md");
        n += 1;
        if n > 100 {
            return Err(CoreError::Internal(
                "could not find a free event filename".to_string(),
            ));
        }
    }

    vault_fs::create_note(vault, &rel, &content)?;
    change::reindex_path(db, vault, &rel)?;
    events::event_from_note(&fm.extra, &input.title, &rel)
        .ok_or_else(|| CoreError::Internal("event was not persisted".to_string()))
}

/// Update an existing own event's frontmatter (body preserved).
pub fn update_event(db: &Connection, vault: &Path, input: EventInput) -> CoreResult<CalendarEvent> {
    let rel = input.note_path.clone().ok_or_else(|| {
        CoreError::BadRequest("notePath is required to update an event".to_string())
    })?;

    let note = vault_fs::read_note(vault, &rel)?;
    let (_, body) = frontmatter::parse_frontmatter(&note.content);
    let fm = build_frontmatter(&input);
    let content = frontmatter::serialize_frontmatter(&fm, &body);
    std::fs::write(vault.join(&rel), &content)?;
    change::reindex_path(db, vault, &rel)?;

    events::event_from_note(&fm.extra, &input.title, &rel)
        .ok_or_else(|| CoreError::Internal("event was not persisted".to_string()))
}

/// Delete an own event (trashes its note).
pub fn delete_event(
    db: &Connection,
    vault: &Path,
    data_dir: &Path,
    note_path: &str,
) -> CoreResult<()> {
    crate::notes::delete(db, vault, data_dir, note_path)
}

/// List events (own + cached remote) within a date range, recurrences expanded.
pub fn list_events(
    db: &Connection,
    range_start: &str,
    range_end: &str,
) -> CoreResult<Vec<CalendarEvent>> {
    events::query_events(db, range_start, range_end)
}

/// Unified agenda: open tasks with due dates in range + calendar events,
/// merged and sorted by start.
pub fn get_agenda(
    db: &Connection,
    range_start: &str,
    range_end: &str,
) -> CoreResult<Vec<crate::models::AgendaItem>> {
    use crate::models::AgendaItem;
    let mut items = Vec::new();

    let query = crate::models::TaskQuery {
        status: Some("open".to_string()),
        due_after: Some(range_start.to_string()),
        due_before: Some(range_end.to_string()),
        ..Default::default()
    };
    for t in crate::tasks::index::query_tasks(db, &query)? {
        if let Some(due) = t.due_date.clone() {
            items.push(AgendaItem {
                kind: "task".to_string(),
                title: t.text,
                start: due,
                all_day: true,
                source: "tasks".to_string(),
                ref_id: t.id,
                note_path: Some(t.source_note),
            });
        }
    }

    for e in events::query_events(db, range_start, range_end)? {
        items.push(AgendaItem {
            kind: "event".to_string(),
            title: e.title,
            start: e.start,
            all_day: e.all_day,
            source: e.source_id,
            ref_id: e.id,
            note_path: e.note_path,
        });
    }

    items.sort_by(|a, b| a.start.cmp(&b.start));
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema;

    fn ctx() -> (std::path::PathBuf, Connection) {
        let base = std::env::temp_dir().join(format!("novalis-cal-{}", uuid::Uuid::new_v4()));
        let vault = base.join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(base.join("data/db")).unwrap();
        let db = schema::open_db(&base.join("data/db/notes.db")).unwrap();
        (vault, db)
    }

    #[test]
    fn create_then_list_event() {
        let (vault, db) = ctx();
        let e = create_event(
            &db,
            &vault,
            EventInput {
                title: "Sprint review".into(),
                date: "2026-06-02".into(),
                all_day: false,
                start_time: Some("14:00".into()),
                end_time: Some("15:00".into()),
                rrule: None,
                location: None,
                note_path: None,
            },
        )
        .unwrap();
        assert_eq!(e.start, "2026-06-02T14:00");
        assert!(e.note_path.as_deref().unwrap().starts_with("Calendar/"));

        let listed = list_events(&db, "2026-06-01", "2026-06-30").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "Sprint review");

        std::fs::remove_dir_all(vault.parent().unwrap()).ok();
    }
}
