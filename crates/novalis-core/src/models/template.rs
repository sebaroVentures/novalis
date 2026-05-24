use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct NoteTemplate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub content: String,
    pub created: String,
}
