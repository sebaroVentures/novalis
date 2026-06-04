use serde::{Deserialize, Serialize};
use specta::Type;

/// A task extracted from a markdown checkbox line, e.g.
/// `- [ ] Buy milk @due(2026-05-30) @priority(high) @status(todo) #shopping`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub text: String,
    pub completed: bool,
    pub priority: Option<String>,
    pub due_date: Option<String>,
    /// `@start(YYYY-MM-DD)` — the scheduled "do" date (distinct from due).
    #[serde(default)]
    pub start_date: Option<String>,
    /// `@remind(YYYY-MM-DDTHH:MM)` — an absolute (local) reminder datetime.
    #[serde(default)]
    pub remind: Option<String>,
    pub status: Option<String>,
    pub source_note: String,
    pub source_line: usize,
    pub tags: Vec<String>,
    #[serde(default)]
    pub repeat: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    /// The source note's display title (frontmatter / first H1 / filename),
    /// derived consistently with the search index — for board cards/lanes.
    #[serde(default)]
    pub note_title: String,
    /// The nearest preceding markdown heading (the task's section), if any.
    #[serde(default)]
    pub heading: Option<String>,
    /// `@project(slug)` annotation — the task's project bucket.
    #[serde(default)]
    pub project: Option<String>,
    /// `@epic(slug)` annotation.
    #[serde(default)]
    pub epic: Option<String>,
}

/// Filters for [`crate::tasks::service::list`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskQuery {
    /// "open" | "completed" | "all"
    pub status: Option<String>,
    pub priority: Option<String>,
    pub due_before: Option<String>,
    pub due_after: Option<String>,
    pub note: Option<String>,
    pub folder: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskRequest {
    pub text: String,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub due_date: Option<String>,
    /// Explicit destination note (overrides the preference-based strategy).
    pub note_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    pub text: String,
    /// When true the line is captured as a task checkbox; otherwise a bullet.
    #[serde(default)]
    pub as_task: bool,
    pub note_path: Option<String>,
}
