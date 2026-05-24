use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::models::NoteSummary;

/// A node in the recursive vault folder tree.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FolderNode {
    pub name: String,
    pub path: String,
    pub children: Vec<FolderNode>,
    pub notes: Vec<NoteSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub path: String,
    pub note_count: usize,
    pub folder_count: usize,
    pub total_words: usize,
    pub total_tasks: usize,
    pub completed_tasks: usize,
}

/// Aggregate vault statistics, including a tag histogram.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultStats {
    pub note_count: usize,
    pub word_count: usize,
    pub task_total: usize,
    pub task_completed: usize,
    pub tag_distribution: HashMap<String, usize>,
}

/// A sync-conflict file detected in the vault (e.g. OneDrive `note (1).md`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub id: String,
    pub original_path: String,
    pub conflict_path: String,
    pub detected_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolveConflictRequest {
    /// "original" | "conflict" | "both"
    pub keep: String,
    /// Vault-relative path to the original file (authoritative copy).
    pub original_path: String,
    /// Vault-relative path to the conflict file as reported by list_conflicts.
    pub conflict_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDiff {
    pub original_path: String,
    pub conflict_path: String,
    pub original_content: String,
    pub conflict_content: String,
    pub original_exists: bool,
}
