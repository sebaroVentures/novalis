//! Sync-conflict detection and resolution.
//!
//! File-sync tools (OneDrive, Dropbox, …) leave conflict copies like
//! `note (1).md` or `note-DESKTOP-AB12.md` when two devices edit offline. We
//! detect them, expose a diff, and resolve by keeping the original, promoting
//! the conflict, or preserving both. Pure filesystem work plus index upkeep.

use std::path::{Path, PathBuf};

use chrono::Utc;
use regex::Regex;
use rusqlite::Connection;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::change;
use crate::error::{CoreError, CoreResult};
use crate::models::{ConflictDiff, ConflictFile, ResolveConflictRequest};

fn conflict_patterns() -> [Regex; 3] {
    [
        // "filename (1).md"
        Regex::new(r"^(.+)\s+\(\d+\)(\.md)$").unwrap(),
        // "filename-DESKTOP-XXXXX.md"
        Regex::new(r"^(.+)-DESKTOP-[A-Z0-9]+(\.md)$").unwrap(),
        // "filename (COMPUTER's conflicted copy).md"
        Regex::new(r"^(.+)\s+\(.+'s conflicted copy[^)]*\)(\.md)$").unwrap(),
    ]
}

/// Scan the vault for sync-conflict files.
pub fn list_conflicts(vault: &Path) -> Vec<ConflictFile> {
    let patterns = conflict_patterns();
    let mut conflicts = Vec::new();

    for entry in WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let filename = entry.file_name().to_string_lossy().to_string();
        let rel = entry
            .path()
            .strip_prefix(vault)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .replace('\\', "/");

        for pattern in &patterns {
            if let Some(caps) = pattern.captures(&filename) {
                let original_stem = caps.get(1).unwrap().as_str();
                let ext = caps.get(2).unwrap().as_str();
                let original_name = format!("{original_stem}{ext}");

                let parent = entry.path().parent().unwrap_or(entry.path());
                let original_abs = parent.join(&original_name);
                let original_rel = original_abs
                    .strip_prefix(vault)
                    .unwrap_or(&original_abs)
                    .to_string_lossy()
                    .replace('\\', "/");

                let detected_at = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .map(|t| {
                        let dt: chrono::DateTime<chrono::Utc> = t.into();
                        dt.to_rfc3339()
                    })
                    .unwrap_or_default();

                conflicts.push(ConflictFile {
                    id: Uuid::new_v4().to_string(),
                    original_path: original_rel,
                    conflict_path: rel.clone(),
                    detected_at,
                });
                break;
            }
        }
    }

    conflicts
}

/// Read both sides of a conflict for diffing (each capped at 1 MiB).
pub fn conflict_diff(vault: &Path, original: &str, conflict: &str) -> CoreResult<ConflictDiff> {
    let original_abs = safe_vault_join(vault, original)?;
    let conflict_abs = safe_vault_join(vault, conflict)?;

    if !conflict_abs.exists() {
        return Err(CoreError::NotFound(format!(
            "Conflict file does not exist: {conflict}"
        )));
    }

    let original_exists = original_abs.exists();
    let original_content = if original_exists {
        read_capped(&original_abs, 1024 * 1024)?
    } else {
        String::new()
    };
    let conflict_content = read_capped(&conflict_abs, 1024 * 1024)?;

    Ok(ConflictDiff {
        original_path: original.to_string(),
        conflict_path: conflict.to_string(),
        original_content,
        conflict_content,
        original_exists,
    })
}

/// Resolve a conflict. Returns the new path when `keep == "both"`.
pub fn resolve_conflict(
    db: &Connection,
    vault: &Path,
    req: &ResolveConflictRequest,
) -> CoreResult<Option<String>> {
    let original_rel = req.original_path.trim();
    let conflict_rel = req.conflict_path.trim();

    if original_rel.is_empty() || conflict_rel.is_empty() {
        return Err(CoreError::BadRequest(
            "originalPath and conflictPath are required".to_string(),
        ));
    }

    let original_abs = safe_vault_join(vault, original_rel)?;
    let conflict_abs = safe_vault_join(vault, conflict_rel)?;

    if !conflict_abs.exists() {
        return Err(CoreError::NotFound(format!(
            "Conflict file does not exist: {conflict_rel}"
        )));
    }

    match req.keep.as_str() {
        "original" => {
            std::fs::remove_file(&conflict_abs)?;
            change::remove(db, conflict_rel)?;
            Ok(None)
        }
        "conflict" => {
            // Promote the conflict copy: overwrite original's bytes (copy, not
            // rename) so the original path stays stable for the index/editors.
            std::fs::copy(&conflict_abs, &original_abs)?;
            std::fs::remove_file(&conflict_abs)?;
            change::reindex_path(db, vault, original_rel)?;
            change::remove(db, conflict_rel)?;
            Ok(None)
        }
        "both" => {
            let new_rel = rename_conflict_preserving_both(vault, conflict_rel)?;
            change::remove(db, conflict_rel)?;
            change::reindex_path(db, vault, &new_rel)?;
            Ok(Some(new_rel))
        }
        _ => Err(CoreError::BadRequest(
            "keep must be 'original', 'conflict', or 'both'".to_string(),
        )),
    }
}

/// Join `relative` under `vault`, rejecting paths that escape the vault root.
fn safe_vault_join(vault: &Path, relative: &str) -> CoreResult<PathBuf> {
    let rel = relative.trim_start_matches('/');
    let candidate = vault.join(rel);

    let check = candidate
        .canonicalize()
        .unwrap_or_else(|_| candidate.clone());
    let vault_check = vault.canonicalize().unwrap_or_else(|_| vault.to_path_buf());

    if !check.starts_with(&vault_check) {
        return Err(CoreError::BadRequest(format!(
            "Path escapes vault: {relative}"
        )));
    }
    Ok(candidate)
}

fn read_capped(path: &Path, max_bytes: u64) -> CoreResult<String> {
    let meta = std::fs::metadata(path)?;
    if meta.len() > max_bytes {
        return Ok(format!("[File too large to preview: {} bytes]", meta.len()));
    }
    Ok(std::fs::read_to_string(path)?)
}

/// Rename the conflict to `Foo (from sync 2026-05-24 1344).md` next to itself,
/// choosing a name that won't re-trigger the conflict-detection regex.
fn rename_conflict_preserving_both(vault: &Path, conflict_rel: &str) -> CoreResult<String> {
    let conflict_abs = vault.join(conflict_rel);
    let parent = conflict_abs
        .parent()
        .ok_or_else(|| CoreError::Internal("Conflict file has no parent".to_string()))?;
    let filename = conflict_abs
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| CoreError::Internal("Conflict file has no name".to_string()))?;

    let strippers = [
        Regex::new(r"\s+\(\d+\)(\.md)$").unwrap(),
        Regex::new(r"-DESKTOP-[A-Z0-9]+(\.md)$").unwrap(),
        Regex::new(r"\s+\(.+'s conflicted copy[^)]*\)(\.md)$").unwrap(),
    ];
    let mut stem_with_ext: String = filename.to_string();
    for re in &strippers {
        if let Some(caps) = re.captures(&stem_with_ext) {
            let ext = caps.get(1).map(|m| m.as_str()).unwrap_or(".md");
            let base = &stem_with_ext[..caps.get(0).unwrap().start()];
            stem_with_ext = format!("{base}{ext}");
            break;
        }
    }
    let stem = stem_with_ext.strip_suffix(".md").unwrap_or(&stem_with_ext);

    let stamp = Utc::now().format("%Y-%m-%d %H%M").to_string();
    let mut candidate = parent.join(format!("{stem} (from sync {stamp}).md"));
    let mut counter = 2;
    while candidate.exists() {
        candidate = parent.join(format!("{stem} (from sync {stamp} #{counter}).md"));
        counter += 1;
        if counter > 50 {
            return Err(CoreError::Internal(
                "Could not find a free filename for 'keep both'".to_string(),
            ));
        }
    }

    std::fs::rename(&conflict_abs, &candidate)?;

    Ok(candidate
        .strip_prefix(vault)
        .unwrap_or(&candidate)
        .to_string_lossy()
        .replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("novalis-conflict-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn detects_onedrive_numbered_conflict() {
        let vault = temp_vault();
        std::fs::write(vault.join("Note.md"), "original").unwrap();
        std::fs::write(vault.join("Note (1).md"), "conflict").unwrap();

        let conflicts = list_conflicts(&vault);
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].original_path, "Note.md");
        assert_eq!(conflicts[0].conflict_path, "Note (1).md");

        std::fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn ignores_regular_files() {
        let vault = temp_vault();
        std::fs::write(vault.join("Regular Note.md"), "x").unwrap();
        assert!(list_conflicts(&vault).is_empty());
        std::fs::remove_dir_all(&vault).ok();
    }
}
