use serde::{Deserialize, Serialize};
use specta::Type;

/// A full note: raw markdown `content` (frontmatter included) plus a parsed view.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub path: String,
    pub title: String,
    pub content: String,
    pub frontmatter: NoteFrontmatter,
    pub word_count: usize,
}

/// YAML frontmatter. Field names are the literal YAML keys (no camelCase). The
/// `extra` map preserves any unknown keys verbatim so we never drop a user's
/// metadata on round-trip; it's skipped from the TS type as it is open-ended.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct NoteFrontmatter {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub modified: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: serde_json::Value,
}

/// Lightweight note metadata used for lists, the file tree, and search results.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub path: String,
    pub title: String,
    pub folder: String,
    pub tags: Vec<String>,
    pub created: String,
    pub modified: String,
    pub pinned: bool,
    pub word_count: usize,
    pub task_total: usize,
    pub task_completed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteRequest {
    pub path: String,
    pub content: Option<String>,
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetaRequest {
    pub path: Option<String>,
    pub tags: Option<Vec<String>>,
    pub pinned: Option<bool>,
    pub aliases: Option<Vec<String>>,
}
