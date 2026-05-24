//! Vault filesystem operations: notes CRUD, folder tree, move/duplicate.
//! Pure functions over a `vault: &Path` — no shared state, fully testable.

use std::path::Path;

use chrono::Utc;
use walkdir::WalkDir;

use crate::error::{CoreError, CoreResult};
use crate::models::{FolderNode, Note, NoteFrontmatter, NoteSummary};
use crate::vault::frontmatter;
use crate::{tasks, trash};

/// Whether a path component should be skipped (hidden files/folders, incl. `.novalis`).
fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Convert an absolute path to a vault-relative, forward-slashed path.
fn to_relative(vault: &Path, abs: &Path) -> String {
    abs.strip_prefix(vault)
        .unwrap_or(abs)
        .to_string_lossy()
        .replace('\\', "/")
}

/// List all notes in the vault, returning summaries.
pub fn list_notes(vault: &Path) -> Vec<NoteSummary> {
    let mut notes = Vec::new();

    for entry in WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            // Skip hidden files/folders and the media directory at vault root.
            if is_hidden(&name) {
                return false;
            }
            if e.depth() == 1 && name.as_ref() == "media" {
                return false;
            }
            true
        })
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        let relative = to_relative(vault, path);
        match build_summary(vault, &relative) {
            Ok(summary) => notes.push(summary),
            Err(e) => log::warn!("skipping {relative}: {e}"),
        }
    }

    notes
}

/// Build a [`NoteSummary`] for a single note.
pub fn build_summary(vault: &Path, relative: &str) -> CoreResult<NoteSummary> {
    let abs = vault.join(relative);
    let content = std::fs::read_to_string(&abs)?;

    let filename = abs
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let (fm, body) = frontmatter::parse_frontmatter(&content);
    let title = frontmatter::extract_title(&fm, &body, &filename);
    let wc = frontmatter::word_count(&body);

    let folder = Path::new(relative)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();

    // M1: count checkboxes. The full task index (with metadata) arrives in M2.
    let (task_total, task_completed) = tasks::count(&content);

    Ok(NoteSummary {
        path: relative.to_string(),
        title,
        folder,
        tags: fm.tags.clone(),
        created: fm.created.clone(),
        modified: fm.modified.clone(),
        pinned: fm.pinned,
        word_count: wc,
        task_total,
        task_completed,
    })
}

/// Read a full note from disk.
pub fn read_note(vault: &Path, relative: &str) -> CoreResult<Note> {
    let abs = vault.join(relative);
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Note not found: {relative}")));
    }

    let content = std::fs::read_to_string(&abs)?;
    let filename = abs
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let (fm, body) = frontmatter::parse_frontmatter(&content);
    let title = frontmatter::extract_title(&fm, &body, &filename);
    let wc = frontmatter::word_count(&body);

    Ok(Note {
        path: relative.to_string(),
        title,
        content,
        frontmatter: fm,
        word_count: wc,
    })
}

/// Write content to a note, updating the modified timestamp.
pub fn write_note(vault: &Path, relative: &str, content: &str) -> CoreResult<()> {
    let abs = vault.join(relative);
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Note not found: {relative}")));
    }

    let updated = frontmatter::update_modified(content);
    std::fs::write(&abs, &updated)?;
    Ok(())
}

/// Create a new note. Generates frontmatter with created/modified timestamps.
pub fn create_note(vault: &Path, relative: &str, content: &str) -> CoreResult<Note> {
    let abs = vault.join(relative);
    if abs.exists() {
        return Err(CoreError::AlreadyExists(format!(
            "Note already exists: {relative}"
        )));
    }

    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let now = Utc::now().to_rfc3339();
    let filename = abs
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let stem = filename.strip_suffix(".md").unwrap_or(&filename);

    let final_content = if content.is_empty() {
        let fm = NoteFrontmatter {
            title: Some(stem.to_string()),
            created: now.clone(),
            modified: now,
            ..Default::default()
        };
        frontmatter::serialize_frontmatter(&fm, &format!("\n# {stem}\n"))
    } else if !content.starts_with("---") {
        let fm = NoteFrontmatter {
            title: Some(stem.to_string()),
            created: now.clone(),
            modified: now,
            ..Default::default()
        };
        frontmatter::serialize_frontmatter(&fm, content)
    } else {
        let (mut fm, body) = frontmatter::parse_frontmatter(content);
        if fm.created.is_empty() {
            fm.created = now.clone();
        }
        if fm.modified.is_empty() {
            fm.modified = now;
        }
        frontmatter::serialize_frontmatter(&fm, &body)
    };

    std::fs::write(&abs, &final_content)?;
    read_note(vault, relative)
}

/// Append a single line to a note's body, creating the note (with default
/// frontmatter) if it does not yet exist. Does not re-index — the caller does.
pub fn append_line(vault: &Path, relative: &str, line: &str) -> CoreResult<()> {
    let abs = vault.join(relative);
    if !abs.exists() {
        create_note(vault, relative, "")?;
    }

    let mut content = std::fs::read_to_string(&abs)?;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(line);
    content.push('\n');

    std::fs::write(&abs, &content)?;
    Ok(())
}

/// Delete a note by moving it to trash (in `data_dir`).
pub fn delete_note(vault: &Path, data_dir: &Path, relative: &str) -> CoreResult<()> {
    trash::trash_note(vault, data_dir, relative)
}

/// Move/rename a note.
pub fn move_note(vault: &Path, from: &str, to: &str) -> CoreResult<()> {
    let abs_from = vault.join(from);
    let abs_to = vault.join(to);

    if !abs_from.exists() {
        return Err(CoreError::NotFound(format!(
            "Source note not found: {from}"
        )));
    }
    if abs_to.exists() {
        return Err(CoreError::AlreadyExists(format!(
            "Destination already exists: {to}"
        )));
    }

    if let Some(parent) = abs_to.parent() {
        std::fs::create_dir_all(parent)?;
    }

    std::fs::rename(&abs_from, &abs_to)?;
    Ok(())
}

/// Duplicate a note with a " (copy)" suffix.
pub fn duplicate_note(vault: &Path, relative: &str) -> CoreResult<Note> {
    let abs = vault.join(relative);
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Note not found: {relative}")));
    }

    let content = std::fs::read_to_string(&abs)?;

    let stem = Path::new(relative)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let parent = Path::new(relative)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let new_name = format!("{stem} (copy).md");
    let new_relative = if parent.is_empty() {
        new_name
    } else {
        format!("{parent}/{new_name}")
    };

    create_note(vault, &new_relative, &content)
}

/// Build a recursive folder tree of the vault.
pub fn list_folders(vault: &Path) -> FolderNode {
    build_folder_node(vault, vault, "")
}

fn build_folder_node(vault: &Path, dir: &Path, rel_path: &str) -> FolderNode {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "vault".to_string());

    let mut children = Vec::new();
    let mut notes = Vec::new();

    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());

        for entry in entries {
            let fname = entry.file_name().to_string_lossy().to_string();
            if is_hidden(&fname) {
                continue;
            }

            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };

            if ft.is_dir() {
                if rel_path.is_empty() && fname == "media" {
                    continue;
                }
                let child_rel = if rel_path.is_empty() {
                    fname.clone()
                } else {
                    format!("{rel_path}/{fname}")
                };
                children.push(build_folder_node(vault, &entry.path(), &child_rel));
            } else if ft.is_file() && fname.ends_with(".md") {
                let note_rel = if rel_path.is_empty() {
                    fname.clone()
                } else {
                    format!("{rel_path}/{fname}")
                };
                match build_summary(vault, &note_rel) {
                    Ok(summary) => notes.push(summary),
                    Err(e) => log::warn!("skipping {note_rel}: {e}"),
                }
            }
        }
    }

    FolderNode {
        name,
        path: rel_path.to_string(),
        children,
        notes,
    }
}

/// Create a folder in the vault.
pub fn create_folder(vault: &Path, relative: &str) -> CoreResult<()> {
    let abs = vault.join(relative);
    if abs.exists() {
        return Err(CoreError::AlreadyExists(format!(
            "Folder already exists: {relative}"
        )));
    }
    std::fs::create_dir_all(&abs)?;
    Ok(())
}

/// Delete a folder (only if empty).
pub fn delete_folder(vault: &Path, relative: &str) -> CoreResult<()> {
    let abs = vault.join(relative);
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Folder not found: {relative}")));
    }

    let count = std::fs::read_dir(&abs)?.count();
    if count > 0 {
        return Err(CoreError::BadRequest(
            "Folder is not empty. Delete all contents first.".to_string(),
        ));
    }

    std::fs::remove_dir(&abs)?;
    Ok(())
}

/// Move/rename a folder.
pub fn move_folder(vault: &Path, from: &str, to: &str) -> CoreResult<()> {
    let abs_from = vault.join(from);
    let abs_to = vault.join(to);

    if !abs_from.exists() {
        return Err(CoreError::NotFound(format!(
            "Source folder not found: {from}"
        )));
    }
    if abs_to.exists() {
        return Err(CoreError::AlreadyExists(format!(
            "Destination folder already exists: {to}"
        )));
    }

    if let Some(parent) = abs_to.parent() {
        std::fs::create_dir_all(parent)?;
    }

    std::fs::rename(&abs_from, &abs_to)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("novalis-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn append_line_creates_note_when_missing() {
        let vault = temp_vault();
        append_line(&vault, "_Inbox.md", "- [ ] hello").unwrap();
        let content = std::fs::read_to_string(vault.join("_Inbox.md")).unwrap();
        assert!(
            content.starts_with("---"),
            "expected frontmatter, got: {content}"
        );
        assert!(content.contains("- [ ] hello"));
        assert!(content.ends_with('\n'));
        std::fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn append_line_preserves_existing_content() {
        let vault = temp_vault();
        std::fs::write(
            vault.join("notes.md"),
            "---\ntitle: X\n---\n\n# X\n\nbody line\n",
        )
        .unwrap();
        append_line(&vault, "notes.md", "- [ ] new task").unwrap();
        let content = std::fs::read_to_string(vault.join("notes.md")).unwrap();
        assert!(content.contains("body line"));
        assert!(content.trim_end().ends_with("- [ ] new task"));
        assert!(content.ends_with('\n'));
        std::fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn create_read_roundtrip_with_task_counts() {
        let vault = temp_vault();
        create_note(&vault, "todo.md", "- [ ] a\n- [x] b\n").unwrap();
        let summary = build_summary(&vault, "todo.md").unwrap();
        assert_eq!(summary.task_total, 2);
        assert_eq!(summary.task_completed, 1);
        let note = read_note(&vault, "todo.md").unwrap();
        assert!(note.content.contains("- [x] b"));
        std::fs::remove_dir_all(&vault).ok();
    }
}
