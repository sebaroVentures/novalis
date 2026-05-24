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
            if let (Some(repeat), Some(due)) = (t.repeat.as_deref(), t.due_date.as_deref()) {
                if let Ok(date) = chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d") {
                    if let Some(next) = index::next_due(date, repeat) {
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
        index::build_task_line(text, None, None, None)
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
}
