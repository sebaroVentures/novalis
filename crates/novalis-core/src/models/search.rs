use serde::{Deserialize, Serialize};
use specta::Type;

/// A full-text search hit with an FTS5 snippet and rank-derived score.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub score: f64,
}

/// A distinct note tag with the number of notes carrying it. Powers the tag
/// browser and `#tag` autocomplete.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: u32,
}
