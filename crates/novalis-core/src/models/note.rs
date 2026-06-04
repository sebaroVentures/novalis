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
    #[serde(default)]
    pub aliases: Vec<String>,
    pub created: String,
    pub modified: String,
    pub pinned: bool,
    pub word_count: usize,
    pub task_total: usize,
    pub task_completed: usize,
    /// True for an "online only" cloud placeholder (OneDrive/iCloud) whose
    /// content isn't on disk yet, so opening it triggers a network download.
    pub cloud_only: bool,
}

/// One matching line within a note that links to or mentions a target title.
/// `line` is 1-based and refers to the raw file (frontmatter included), so it
/// can locate the line again for [`crate::notes::link_mention`].
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkMatch {
    pub line: usize,
    pub snippet: String,
}

/// A note that references a target title, grouped with the lines where it does.
/// Used for the "linked references" and "unlinked mentions" panels.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkReference {
    pub path: String,
    pub title: String,
    pub folder: String,
    pub modified: String,
    pub matches: Vec<LinkMatch>,
}

/// A node (note) in the local link graph.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub path: String,
    pub title: String,
}

/// A directed `[[link]]` edge between two notes, by path.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

/// The 1-hop link neighborhood of a note: the note itself (`center`), the notes
/// it links to, and the notes that link to it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteGraph {
    pub center: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
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
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub pinned: Option<bool>,
    pub aliases: Option<Vec<String>>,
}
