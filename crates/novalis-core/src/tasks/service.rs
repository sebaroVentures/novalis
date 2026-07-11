//! Task service layer: create, toggle (with recurrence spawn), set status, and
//! quick-capture. Resolves the destination note from preferences and keeps the
//! index in sync via [`change::reindex_path`].

use std::path::Path;

use rusqlite::Connection;

use crate::change;
use crate::error::{CoreError, CoreResult};
use crate::models::{CaptureRequest, CreateTaskRequest, Task, TaskQuery};
use crate::tasks::{index, nldate};
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

    let prefs = config::try_read_preferences(vault)?;
    let today = chrono::Local::now().date_naive();
    let dest = prefs
        .task_view
        .task_creation
        .resolve(req.note_path.as_deref(), today);

    // The `dueDate` field accepts a natural-language phrase ("next friday",
    // "in 3 days") as well as an explicit `YYYY-MM-DD`; resolve it to a concrete
    // date relative to today. An explicit ISO date passes through unchanged. A
    // non-empty phrase we can't resolve is a hard error rather than a silently
    // dropped date.
    let due = match req
        .due_date
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(phrase) => Some(
            nldate::resolve_nl_date(phrase, today)
                .ok_or_else(|| CoreError::BadRequest(format!("Unrecognized due date: {phrase:?}")))?
                .format("%Y-%m-%d")
                .to_string(),
        ),
        None => None,
    };

    let line = index::build_task_line(
        &req.text,
        req.status.as_deref(),
        req.priority.as_deref(),
        None,
        due.as_deref(),
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
/// `YYYY-MM-DDTHH:MM`; `repeat` → `daily|weekly|monthly|yearly` or
/// `every N days|weeks|months`.
pub fn update_task(
    db: &Connection,
    vault: &Path,
    id: &str,
    field: &str,
    value: Option<&str>,
) -> CoreResult<()> {
    if !matches!(
        field,
        "project" | "epic" | "priority" | "due" | "start" | "remind" | "repeat"
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
            "repeat" => index::is_valid_repeat(v),
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

/// Move a task — and its contiguous subtask block — from its current source
/// note to `dest_note`, appending it to the destination. The task id is derived
/// from path + line and therefore changes after the move, so callers reload.
/// Reindexes BOTH the source and destination notes.
pub fn move_task(db: &Connection, vault: &Path, id: &str, dest_note: &str) -> CoreResult<()> {
    let dest = dest_note.trim();
    if dest.is_empty() || !dest.ends_with(".md") {
        return Err(CoreError::BadRequest(
            "Destination note must be a .md path".to_string(),
        ));
    }

    let (src_note, line) = index::task_location(db, id)?;
    if src_note == dest {
        return Ok(()); // no-op: already in the destination note
    }

    // Cut the task (and any indented children) verbatim from the source, then
    // append to the destination. `append_line` creates the destination note
    // with default frontmatter if it does not yet exist.
    let block = index::cut_task_block(vault, &src_note, line)?;
    for l in &block {
        vault_fs::append_line(vault, dest, l)?;
    }

    change::reindex_path(db, vault, &src_note)?;
    change::reindex_path(db, vault, dest)?;
    Ok(())
}

/// A valid `@project` / `@epic` slug: non-empty, `[a-z0-9-]+`.
fn is_slug(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Quick-capture a single line (task or bullet) into the resolved note.
/// Returns the destination path. Any inline `@due(...)`/`@start(...)` written
/// as a natural-language phrase ("next friday") is resolved to a concrete date
/// relative to today before the line is written; unrecognized phrases are left
/// verbatim (and logged) rather than dropped.
pub fn quick_capture(db: &Connection, vault: &Path, req: CaptureRequest) -> CoreResult<String> {
    let text = req.text.trim();
    if text.is_empty() {
        return Err(CoreError::BadRequest(
            "Capture text must not be empty".to_string(),
        ));
    }

    let prefs = config::try_read_preferences(vault)?;
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
    let line = nldate::resolve_inline_dates(&line, today);
    vault_fs::append_line(vault, &dest, &line)?;
    change::reindex_path(db, vault, &dest)?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::schema;

    struct Ctx {
        _tmp: tempfile::TempDir,
        vault: std::path::PathBuf,
        db: Connection,
    }

    fn ctx() -> Ctx {
        let base = tempfile::tempdir().unwrap();
        let vault = base.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(base.path().join("data/db")).unwrap();
        let db = schema::open_db(&base.path().join("data/db/notes.db")).unwrap();
        Ctx {
            _tmp: base,
            vault,
            db,
        }
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
    }

    #[test]
    fn update_task_sets_and_clears_repeat_and_rejects_invalid() {
        let c = ctx();
        let task = create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Standup".to_string(),
                status: None,
                priority: None,
                due_date: None,
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();

        // Set, read back through the index.
        update_task(&c.db, &c.vault, &task.id, "repeat", Some("weekly")).unwrap();
        let t = list(&c.db, &TaskQuery::default())
            .unwrap()
            .into_iter()
            .find(|t| t.id == task.id)
            .unwrap();
        assert_eq!(t.repeat.as_deref(), Some("weekly"));

        // Clear it.
        update_task(&c.db, &c.vault, &task.id, "repeat", None).unwrap();
        let t = list(&c.db, &TaskQuery::default())
            .unwrap()
            .into_iter()
            .find(|t| t.id == task.id)
            .unwrap();
        assert_eq!(t.repeat, None);

        // Unknown interval is rejected without writing.
        assert!(update_task(&c.db, &c.vault, &task.id, "repeat", Some("fortnightly")).is_err());
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
    }

    #[test]
    fn move_task_relocates_to_another_note() {
        let c = ctx();
        let task = create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Relocate me".to_string(),
                status: None,
                priority: None,
                due_date: None,
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();
        assert_eq!(task.source_note, "_Inbox.md");

        move_task(&c.db, &c.vault, &task.id, "Projects/Work.md").unwrap();

        let after = list(&c.db, &TaskQuery::default()).unwrap();
        let moved = after.iter().find(|t| t.text == "Relocate me").unwrap();
        assert_eq!(moved.source_note, "Projects/Work.md");
        // The destination note was created and the inbox no longer holds it.
        assert!(c.vault.join("Projects/Work.md").exists());
        assert!(!std::fs::read_to_string(c.vault.join("_Inbox.md"))
            .unwrap()
            .contains("Relocate me"));
    }

    #[test]
    fn move_task_carries_subtasks() {
        let c = ctx();
        // Build a parent + two indented children directly in the source note.
        crate::vault::fs::append_line(&c.vault, "_Inbox.md", "- [ ] Parent").unwrap();
        crate::vault::fs::append_line(&c.vault, "_Inbox.md", "  - [ ] Child A").unwrap();
        crate::vault::fs::append_line(&c.vault, "_Inbox.md", "  - [ ] Child B").unwrap();
        crate::change::reindex_path(&c.db, &c.vault, "_Inbox.md").unwrap();

        let parent = list(&c.db, &TaskQuery::default())
            .unwrap()
            .into_iter()
            .find(|t| t.text == "Parent")
            .unwrap();

        move_task(&c.db, &c.vault, &parent.id, "Projects/Plan.md").unwrap();

        let after = list(&c.db, &TaskQuery::default()).unwrap();
        let new_parent = after.iter().find(|t| t.text == "Parent").unwrap();
        assert_eq!(new_parent.source_note, "Projects/Plan.md");
        // All three lines moved and the parent/child link survived the move.
        for child in ["Child A", "Child B"] {
            let c_task = after.iter().find(|t| t.text == child).unwrap();
            assert_eq!(c_task.source_note, "Projects/Plan.md");
            assert_eq!(c_task.parent_id.as_deref(), Some(new_parent.id.as_str()));
        }
    }

    #[test]
    fn move_task_same_note_is_noop() {
        let c = ctx();
        let task = create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Stay put".to_string(),
                status: None,
                priority: None,
                due_date: None,
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();
        let before = std::fs::read_to_string(c.vault.join("_Inbox.md")).unwrap();

        move_task(&c.db, &c.vault, &task.id, "_Inbox.md").unwrap();

        assert_eq!(
            std::fs::read_to_string(c.vault.join("_Inbox.md")).unwrap(),
            before
        );
    }

    #[test]
    fn move_task_rejects_bad_dest_and_missing_task() {
        let c = ctx();
        let task = create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Anchor".to_string(),
                status: None,
                priority: None,
                due_date: None,
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();

        // Non-.md / empty destinations are rejected before any write.
        assert!(move_task(&c.db, &c.vault, &task.id, "Projects/Work").is_err());
        assert!(move_task(&c.db, &c.vault, &task.id, "   ").is_err());
        // Unknown id is a NotFound.
        assert!(move_task(&c.db, &c.vault, "does-not-exist", "Projects/Work.md").is_err());
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
    }

    #[test]
    fn completing_every_n_task_spawns_next() {
        let c = ctx();
        create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Sprint review @repeat(every 2 weeks) @due(2026-05-24)".to_string(),
                status: None,
                priority: None,
                due_date: None,
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();

        let id = list(&c.db, &TaskQuery::default()).unwrap()[0].id.clone();
        toggle(&c.db, &c.vault, &id).unwrap();

        // Two weeks after 2026-05-24 is 2026-06-07.
        let after = list(&c.db, &TaskQuery::default()).unwrap();
        assert!(after
            .iter()
            .any(|t| !t.completed && t.due_date.as_deref() == Some("2026-06-07")));
    }

    #[test]
    fn create_resolves_natural_language_due_date() {
        let c = ctx();
        // An explicit ISO date passes through untouched.
        let iso = create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Explicit".to_string(),
                status: None,
                priority: None,
                due_date: Some("2026-07-15".to_string()),
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();
        assert_eq!(iso.due_date.as_deref(), Some("2026-07-15"));

        // A natural-language phrase resolves relative to today.
        let today = chrono::Local::now().date_naive();
        let tomorrow = (today + chrono::Days::new(1))
            .format("%Y-%m-%d")
            .to_string();
        let nl = create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Relative".to_string(),
                status: None,
                priority: None,
                due_date: Some("tomorrow".to_string()),
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();
        assert_eq!(nl.due_date.as_deref(), Some(tomorrow.as_str()));

        // An unrecognized phrase fails loud rather than dropping the date.
        assert!(create(
            &c.db,
            &c.vault,
            CreateTaskRequest {
                text: "Bad".to_string(),
                status: None,
                priority: None,
                due_date: Some("someday".to_string()),
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .is_err());
    }

    #[test]
    fn quick_capture_resolves_inline_due_phrase() {
        let c = ctx();
        let today = chrono::Local::now().date_naive();
        let tomorrow = (today + chrono::Days::new(1))
            .format("%Y-%m-%d")
            .to_string();

        quick_capture(
            &c.db,
            &c.vault,
            CaptureRequest {
                text: "Pay rent @due(tomorrow)".to_string(),
                as_task: true,
                note_path: Some("_Inbox.md".to_string()),
            },
        )
        .unwrap();

        let tasks = list(&c.db, &TaskQuery::default()).unwrap();
        let t = tasks
            .iter()
            .find(|t| t.text.starts_with("Pay rent"))
            .unwrap();
        assert_eq!(t.due_date.as_deref(), Some(tomorrow.as_str()));
    }
}
