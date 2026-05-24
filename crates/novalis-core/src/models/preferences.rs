use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    #[serde(default)]
    pub task_view: TaskViewPrefs,
    #[serde(default)]
    pub file_tree: FileTreePrefs,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskViewPrefs {
    #[serde(default = "default_task_mode")]
    pub default_mode: String,
    #[serde(default = "default_kanban_columns")]
    pub kanban_columns: Vec<KanbanColumnDef>,
    #[serde(default)]
    pub task_creation: TaskCreationPrefs,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreationPrefs {
    #[serde(default = "default_creation_strategy")]
    pub strategy: String,
    #[serde(default = "default_inbox_path")]
    pub inbox_path: String,
}

impl TaskCreationPrefs {
    /// Resolve the destination note (vault-relative path) for a newly created
    /// task, given an optional explicit override and the current date.
    pub fn resolve(&self, note_path_override: Option<&str>, today: chrono::NaiveDate) -> String {
        if let Some(path) = note_path_override {
            return path.to_string();
        }
        match self.strategy.as_str() {
            "daily" => format!(
                "journal/{}/{}.md",
                today.format("%Y"),
                today.format("%Y-%m-%d")
            ),
            // "inbox", "active-note" (without override), and any unknown value
            _ => self.inbox_path.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KanbanColumnDef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileTreePrefs {
    #[serde(default = "default_sort_by")]
    pub sort_by: String,
    #[serde(default = "default_sort_dir")]
    pub sort_dir: String,
}

fn default_task_mode() -> String {
    "list".to_string()
}

fn default_creation_strategy() -> String {
    "inbox".to_string()
}

fn default_inbox_path() -> String {
    "_Inbox.md".to_string()
}

fn default_sort_by() -> String {
    "name".to_string()
}

fn default_sort_dir() -> String {
    "asc".to_string()
}

fn default_kanban_columns() -> Vec<KanbanColumnDef> {
    vec![
        KanbanColumnDef {
            id: "backlog".to_string(),
            title: "Backlog".to_string(),
        },
        KanbanColumnDef {
            id: "todo".to_string(),
            title: "To Do".to_string(),
        },
        KanbanColumnDef {
            id: "in-progress".to_string(),
            title: "In Progress".to_string(),
        },
        KanbanColumnDef {
            id: "review".to_string(),
            title: "Review".to_string(),
        },
        KanbanColumnDef {
            id: "done".to_string(),
            title: "Done".to_string(),
        },
    ]
}

impl Default for TaskViewPrefs {
    fn default() -> Self {
        Self {
            default_mode: default_task_mode(),
            kanban_columns: default_kanban_columns(),
            task_creation: TaskCreationPrefs::default(),
        }
    }
}

impl Default for TaskCreationPrefs {
    fn default() -> Self {
        Self {
            strategy: default_creation_strategy(),
            inbox_path: default_inbox_path(),
        }
    }
}

impl Default for FileTreePrefs {
    fn default() -> Self {
        Self {
            sort_by: default_sort_by(),
            sort_dir: default_sort_dir(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn day() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 5, 24).unwrap()
    }

    #[test]
    fn resolve_uses_inbox_path_for_inbox_strategy() {
        let prefs = TaskCreationPrefs {
            strategy: "inbox".to_string(),
            inbox_path: "_Inbox.md".to_string(),
        };
        assert_eq!(prefs.resolve(None, day()), "_Inbox.md");
    }

    #[test]
    fn resolve_builds_daily_note_path_for_daily_strategy() {
        let prefs = TaskCreationPrefs {
            strategy: "daily".to_string(),
            inbox_path: "_Inbox.md".to_string(),
        };
        assert_eq!(prefs.resolve(None, day()), "journal/2026/2026-05-24.md");
    }

    #[test]
    fn resolve_prefers_explicit_override() {
        let prefs = TaskCreationPrefs::default();
        assert_eq!(
            prefs.resolve(Some("Projects/Work.md"), day()),
            "Projects/Work.md"
        );
    }

    #[test]
    fn resolve_falls_back_to_inbox_for_active_note_without_override() {
        let prefs = TaskCreationPrefs {
            strategy: "active-note".to_string(),
            inbox_path: "_Inbox.md".to_string(),
        };
        assert_eq!(prefs.resolve(None, day()), "_Inbox.md");
    }
}
