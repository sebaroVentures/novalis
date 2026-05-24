//! Vault-level aggregate information and statistics.

use std::collections::HashMap;
use std::path::Path;

use walkdir::WalkDir;

use crate::models::{VaultInfo, VaultStats};
use crate::vault::fs as vault_fs;

/// Summary counts for the whole vault.
pub fn vault_info(vault: &Path) -> VaultInfo {
    let notes = vault_fs::list_notes(vault);

    let mut folder_count = 0;
    for entry in WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_dir() && entry.path() != vault {
            folder_count += 1;
        }
    }

    VaultInfo {
        path: vault.to_string_lossy().to_string(),
        note_count: notes.len(),
        folder_count,
        total_words: notes.iter().map(|n| n.word_count).sum(),
        total_tasks: notes.iter().map(|n| n.task_total).sum(),
        completed_tasks: notes.iter().map(|n| n.task_completed).sum(),
    }
}

/// Detailed statistics including a tag histogram.
pub fn vault_stats(vault: &Path) -> VaultStats {
    let notes = vault_fs::list_notes(vault);

    let mut tag_distribution: HashMap<String, usize> = HashMap::new();
    let mut word_count = 0;
    let mut task_total = 0;
    let mut task_completed = 0;

    for note in &notes {
        word_count += note.word_count;
        task_total += note.task_total;
        task_completed += note.task_completed;
        for tag in &note.tags {
            *tag_distribution.entry(tag.clone()).or_insert(0) += 1;
        }
    }

    VaultStats {
        note_count: notes.len(),
        word_count,
        task_total,
        task_completed,
        tag_distribution,
    }
}
