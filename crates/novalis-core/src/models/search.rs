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
