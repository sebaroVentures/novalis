//! Task service layer: create, toggle (with recurrence spawn), set status, and
//! quick-capture. Resolves the destination note from preferences and keeps the
//! index in sync via [`change::reindex_path`].

use std::path::Path;

use rusqlite::Connection;

use crate::change;
use crate::error::{CoreError, CoreResult};
use crate::models::{CaptureRequest, CreateTaskRequest, Task, TaskQuery};
use crate::tasks::index;
use crate::vault::{config, fs as vault_fs};

/// List tasks matching `query`.
pub fn list(db: &Connection, query: &TaskQuery) -> CoreResult<Vec<Task>> {
    index::query_tasks(db, query)
}

/// Create a task as a markdown checkbox line in the resolved destination note.
pub fn create(db: &Connection, vault: &Path, req: CreateTaskRequest) -> CoreResult<Task> {
    if req.text.trim().is_empty() {
        return Err(CoreError::BadRequest(
            "Task text must not be empty".to_string(),
        ));
    }

    let prefs = config::read_preferences(vault);
    let today = chrono::Local::now().date_naive();
    let dest = prefs
        .task_view
        .task_creation
        .resolve(req.note_path.as_deref(), today);

    let line = index::build_task_line(
        &req.text,
        req.status.as_deref(),
        req.priority.as_deref(),
        None,
        req.due_date.as_deref(),
    );
    vault_fs::append_line(vault, &dest, &line)?;
    change::reindex_path(db, vault, &dest)?;

    // The appended line is the last task parsed in the note.
    let note = vault_fs::read_note(vault, &dest)?;
    index::extract_tasks(&note.content, &dest)
        .into_iter()
        .last()
        .ok_or_else(|| CoreError::Internal("Task was not persisted".to_string()))
}

/// Toggle a task's completion. On completing a recurring task, spawn its next
/// occurrence. Returns the new completion state.
pub fn toggle(db: &Connection, vault: &Path, id: &str) -> CoreResult<bool> {
    let (note_path, line) = index::task_location(db, id)?;
    let new_state = index::toggle_task(vault, &note_path, line)?;

    if new_state {
        let note = vault_fs::read_note(vault, &note_path)?;
        let tasks = index::extract_tasks(&note.content, &note_path);
        if let Some(t) = tasks.iter().find(|t| t.source_line == line) {
            if let Some(due) = t.due_date.as_deref() {
                if let Ok(date) = chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d") {
                    // Prefer an explicit @rrule; fall back to the simple @repeat interval.
                    let next = index::task_rrule(&t.text)
                        .and_then(|rr| index::next_rrule(date, &rr))
                        .or_else(|| t.repeat.as_deref().and_then(|r| index::next_due(date, r)));
                    if let Some(next) = next {
                        let next_text =
                            t.text
                                .replacen(&format!("@due({due})"), &format!("@due({next})"), 1);
                        // Guard against double-spawn on toggle off/on.
                        let exists = tasks.iter().any(|x| x.text == next_text && !x.completed);
                        if !exists {
                            vault_fs::append_line(
                                vault,
                                &note_path,
                                &format!("- [ ] {next_text}"),
                            )?;
                        }
                    }
                }
            }
        }
    }

    change::reindex_path(db, vault, &note_path)?;
    Ok(new_state)
}

/// Update a task's `@status(...)` annotation (used by the Kanban board).
pub fn set_status(db: &Connection, vault: &Path, id: &str, status: &str) -> CoreResult<()> {
    let (note_path, line) = index::task_location(db, id)?;
    index::update_task_status(vault, &note_path, line, status)?;
    change::reindex_path(db, vault, &note_path)?;
    Ok(())
}

/// Set or clear an annotation on a task in its source markdown (the annotation
/// key equals `field`). `value = None` removes it. Supported fields and their
/// value rules: `project`/`epic` → slug `[a-z0-9-]+`; `priority` →
/// `urgent|high|medium|low`; `due`/`start` → `YYYY-MM-DD`; `remind` →
/// `YYYY-MM-DDTHH:MM`.
pub fn update_task(
    db: &Connection,
    vault: &Path,
    id: &str,
    field: &str,
    value: Option<&str>,
) -> CoreResult<()> {
    if !matches!(
        field,
        "project" | "epic" | "priority" | "due" | "start" | "remind"
    ) {
        return Err(CoreError::BadRequest(format!(
            "Unsupported task field: {field}"
        )));
    }
    if let Some(v) = value {
        let ok = match field {
            "project" | "epic" => is_slug(v),
            "priority" => matches!(v, "urgent" | "high" | "medium" | "low"),
            "due" | "start" => chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d").is_ok(),
            "remind" => chrono::NaiveDateTime::parse_from_str(v, "%Y-%m-%dT%H:%M").is_ok(),
            _ => false,
        };
        if !ok {
            return Err(CoreError::BadRequest(format!(
                "Invalid value {v:?} for task field {field}"
            )));
        }
    }
    let (note_path, line) = index::task_location(db, id)?;
    index::update_task_annotation(vault, &note_path, line, field, value)?;
    change::reindex_path(db, vault, &note_path)?;
    Ok(())
}

/// Remove a task entirely (delete its checkbox line) from its source note.
pub fn delete_task(db: &Connection, vault: &Path, id: &str) -> CoreResult<()> {
    let (note_path, line) = index::task_location(db, id)?;
    index::delete_task_line(vault, &note_path, line)?;
    change::reindex_path(db, vault, &note_path)?;
    Ok(())
}

/// A valid `@project` / `@epic` slug: non-empty, `[a-z0-9-]+`.
fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Quick-capture a single line (task or bullet) into the resolved note.
/// Returns the destination path.
pub fn quick_capture(db: &Connection, vault: &Path, req: CaptureRequest) -> CoreResult<String> {
    let text = req.text.trim();
    if text.is_empty() {
        return Err(CoreError::BadRequest(
            "Capture text must not be empty".to_string(),
        ));
    }

    let prefs = config::read_preferences(vault);
    let today = chrono::Local::now().date_naive();
    let dest = prefs
        .task_view
        .task_creation
        .resolve(req.note_path.as_deref(), today);

    let line = if req.as_task {
        index::build_task_line(text, None, None, None, None)
    } else {
        format!("- {text}")
    };
    vault_fs::append_line(vault, &dest, &line)?;
    change::reindex_path(db, vault, &dest)?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema;

    struct Ctx {
        vault: std::path::PathBuf,
        db: Connection,
    }

    fn ctx() -> Ctx {
        let base = std::env::temp_dir().join(format!("novalis-tasks-{}", uuid::Uuid::new_v4()));
        let vault = base.join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(base.join("data/db")).unwrap();
        let db = schema::open_db(&base.join("data/db/notes.db")).unwrap();
        Ctx { vault, db }
    }

    #[test]
    fn create_list_toggle_cycle() {
        let c = ctx();
        let task = create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Write report".to_string(),
                status: Some("todo".to_string()),
                priority: Some("high".to_string()),
                due_date: None,
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();
        assert!(!task.completed);

        let open = list(
            &c.db,
            &TaskQuery {
                status: Some("open".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(open.len(), 1);

        let now_done = toggle(&c.db, &c.vault, &task.id).unwrap();
        assert!(now_done);
        let still_open = list(
            &c.db,
            &TaskQuery {
                status: Some("open".to_string()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(still_open.is_empty());

        std::fs::remove_dir_all(c.vault.parent().unwrap()).ok();
    }

    #[test]
    fn update_task_sets_and_clears_project_round_trip() {
        let c = ctx();
        let task = create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Plan launch".to_string(),
                status: None,
                priority: None,
                due_date: None,
                note_path: Some("Work/Q3.md".to_string()),
            },
        )
        .unwrap();
        assert_eq!(task.note_title, "Q3");

        // Assign, then read back through the index.
        update_task(&c.db, &c.vault, &task.id, "project", Some("launch")).unwrap();
        let after = list(&c.db, &TaskQuery::default()).unwrap();
        let t = after.iter().find(|t| t.id == task.id).unwrap();
        assert_eq!(t.project.as_deref(), Some("launch"));

        // Clear it.
        update_task(&c.db, &c.vault, &task.id, "project", None).unwrap();
        let after = list(&c.db, &TaskQuery::default()).unwrap();
        let t = after.iter().find(|t| t.id == task.id).unwrap();
        assert_eq!(t.project, None);

        // Unknown field and invalid slug are rejected without writing.
        assert!(update_task(&c.db, &c.vault, &task.id, "bogus", Some("x")).is_err());
        assert!(update_task(&c.db, &c.vault, &task.id, "project", Some("Bad Slug")).is_err());

        std::fs::remove_dir_all(c.vault.parent().unwrap()).ok();
    }

    #[test]
    fn update_task_sets_priority_and_due_and_rejects_invalid() {
        let c = ctx();
        let task = create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Ship".to_string(),
                status: None,
                priority: None,
                due_date: None,
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();

        update_task(&c.db, &c.vault, &task.id, "priority", Some("high")).unwrap();
        update_task(&c.db, &c.vault, &task.id, "due", Some("2026-06-10")).unwrap();
        let t = list(&c.db, &TaskQuery::default())
            .unwrap()
            .into_iter()
            .find(|t| t.id == task.id)
            .unwrap();
        assert_eq!(t.priority.as_deref(), Some("high"));
        assert_eq!(t.due_date.as_deref(), Some("2026-06-10"));

        // Clearing removes the annotation.
        update_task(&c.db, &c.vault, &task.id, "due", None).unwrap();
        let t = list(&c.db, &TaskQuery::default())
            .unwrap()
            .into_iter()
            .find(|t| t.id == task.id)
            .unwrap();
        assert_eq!(t.due_date, None);

        // Out-of-range priority and malformed date are rejected.
        assert!(update_task(&c.db, &c.vault, &task.id, "priority", Some("epic")).is_err());
        assert!(update_task(&c.db, &c.vault, &task.id, "due", Some("2026/06/10")).is_err());

        std::fs::remove_dir_all(c.vault.parent().unwrap()).ok();
    }

    #[test]
    fn delete_task_removes_only_its_line() {
        let c = ctx();
        let first = create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "First".to_string(),
                status: None,
                priority: None,
                due_date: None,
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();
        create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Second".to_string(),
                status: None,
                priority: None,
                due_date: None,
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();

        delete_task(&c.db, &c.vault, &first.id).unwrap();
        let remaining = list(&c.db, &TaskQuery::default()).unwrap();
        assert!(remaining.iter().all(|t| !t.text.starts_with("First")));
        assert!(remaining.iter().any(|t| t.text.starts_with("Second")));

        std::fs::remove_dir_all(c.vault.parent().unwrap()).ok();
    }

    #[test]
    fn completing_recurring_task_spawns_next() {
        let c = ctx();
        create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Standup @repeat(daily) @due(2026-05-24)".to_string(),
                status: None,
                priority: None,
                due_date: None,
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();

        let tasks = list(&c.db, &TaskQuery::default()).unwrap();
        let id = tasks[0].id.clone();
        toggle(&c.db, &c.vault, &id).unwrap();

        // A fresh open occurrence with the next due date should now exist.
        let after = list(&c.db, &TaskQuery::default()).unwrap();
        assert!(after
            .iter()
            .any(|t| !t.completed && t.due_date.as_deref() == Some("2026-05-25")));

        std::fs::remove_dir_all(c.vault.parent().unwrap()).ok();
    }

    #[test]
    fn completing_rrule_task_spawns_next() {
        let c = ctx();
        create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Standup @rrule(FREQ=WEEKLY;BYDAY=MO) @due(2026-06-01)".to_string(),
                status: None,
                priority: None,
                due_date: None,
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();

        let id = list(&c.db, &TaskQuery::default()).unwrap()[0].id.clone();
        toggle(&c.db, &c.vault, &id).unwrap();

        // The next weekly occurrence (the following Monday) should be spawned.
        let after = list(&c.db, &TaskQuery::default()).unwrap();
        assert!(after
            .iter()
            .any(|t| !t.completed && t.due_date.as_deref() == Some("2026-06-08")));

        std::fs::remove_dir_all(c.vault.parent().unwrap()).ok();
    }
}
