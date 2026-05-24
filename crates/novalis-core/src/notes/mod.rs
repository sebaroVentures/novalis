//! Note service layer: combines vault filesystem operations with index upkeep
//! so each Tauri command stays a one-liner. Functions take an explicit
//! `&Connection` and vault/data paths — no shared state, fully testable.

use std::path::Path;

use rusqlite::Connection;

use crate::change;
use crate::error::CoreResult;
use crate::models::{CreateNoteRequest, Note, NoteSummary, NoteTemplate, UpdateMetaRequest};
use crate::vault::{frontmatter, fs as vault_fs};

/// List all note summaries in the vault.
pub fn list(vault: &Path) -> Vec<NoteSummary> {
    vault_fs::list_notes(vault)
}

/// Read a single note.
pub fn get(vault: &Path, path: &str) -> CoreResult<Note> {
    vault_fs::read_note(vault, path)
}

/// Create a note (optionally from a template stored in `data_dir/templates`).
pub fn create(
    db: &Connection,
    vault: &Path,
    data_dir: &Path,
    req: CreateNoteRequest,
) -> CoreResult<Note> {
    let content = req.content.unwrap_or_default();

    let final_content = match req.template {
        Some(template_id) => {
            let tpl_path = data_dir
                .join("templates")
                .join(format!("{template_id}.json"));
            if tpl_path.exists() {
                let data = std::fs::read_to_string(&tpl_path)?;
                let tpl: NoteTemplate = serde_json::from_str(&data)?;
                tpl.content
            } else {
                content
            }
        }
        None => content,
    };

    let note = vault_fs::create_note(vault, &req.path, &final_content)?;
    change::reindex_path(db, vault, &req.path)?;
    Ok(note)
}

/// Overwrite a note's content (updating `modified`) and re-index it.
pub fn update(db: &Connection, vault: &Path, path: &str, content: &str) -> CoreResult<Note> {
    vault_fs::write_note(vault, path, content)?;
    let note = vault_fs::read_note(vault, path)?;
    change::reindex_path(db, vault, path)?;
    Ok(note)
}

/// Update frontmatter metadata (tags/pinned/aliases) without touching the body.
pub fn update_meta(db: &Connection, vault: &Path, req: UpdateMetaRequest) -> CoreResult<Note> {
    let path = req.path.clone().unwrap_or_default();
    let note = vault_fs::read_note(vault, &path)?;
    let (mut fm, body) = frontmatter::parse_frontmatter(&note.content);

    if let Some(tags) = req.tags {
        fm.tags = tags;
    }
    if let Some(pinned) = req.pinned {
        fm.pinned = pinned;
    }
    if let Some(aliases) = req.aliases {
        fm.aliases = aliases;
    }
    fm.modified = chrono::Utc::now().to_rfc3339();

    let new_content = frontmatter::serialize_frontmatter(&fm, &body);
    std::fs::write(vault.join(&path), &new_content)?;

    let updated = vault_fs::read_note(vault, &path)?;
    change::reindex_path(db, vault, &path)?;
    Ok(updated)
}

/// Move/rename a note and update the index.
pub fn move_note(db: &Connection, vault: &Path, from: &str, to: &str) -> CoreResult<Note> {
    vault_fs::move_note(vault, from, to)?;
    change::remove(db, from)?;
    let note = vault_fs::read_note(vault, to)?;
    change::reindex_path(db, vault, to)?;
    Ok(note)
}

/// Duplicate a note with a " (copy)" suffix and index the copy.
pub fn duplicate(db: &Connection, vault: &Path, path: &str) -> CoreResult<Note> {
    let note = vault_fs::duplicate_note(vault, path)?;
    change::reindex_path(db, vault, &note.path)?;
    Ok(note)
}

/// Trash a note and remove it from the index.
pub fn delete(db: &Connection, vault: &Path, data_dir: &Path, path: &str) -> CoreResult<()> {
    vault_fs::delete_note(vault, data_dir, path)?;
    change::remove(db, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{schema, search};

    struct Ctx {
        vault: std::path::PathBuf,
        data: std::path::PathBuf,
        db: Connection,
    }

    fn ctx() -> Ctx {
        let base = std::env::temp_dir().join(format!("novalis-notes-{}", uuid::Uuid::new_v4()));
        let vault = base.join("vault");
        let data = base.join("data");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(data.join("db")).unwrap();
        let db = schema::open_db(&data.join("db/notes.db")).unwrap();
        Ctx { vault, data, db }
    }

    #[test]
    fn create_update_search_delete_cycle() {
        let c = ctx();
        let req = CreateNoteRequest {
            path: "Ideas.md".to_string(),
            content: Some("# Ideas\nthe peregrine falcon dives".to_string()),
            template: None,
        };
        create(&c.db, &c.vault, &c.data, req).unwrap();

        // Indexed and searchable.
        assert_eq!(
            search::search(&c.db, "peregrine", None, None)
                .unwrap()
                .len(),
            1
        );

        // Update changes the index.
        update(&c.db, &c.vault, "Ideas.md", "# Ideas\nthe osprey hunts").unwrap();
        assert!(search::search(&c.db, "peregrine", None, None)
            .unwrap()
            .is_empty());
        assert_eq!(
            search::search(&c.db, "osprey", None, None).unwrap().len(),
            1
        );

        // Delete (trash) removes it from the index.
        delete(&c.db, &c.vault, &c.data, "Ideas.md").unwrap();
        assert!(search::search(&c.db, "osprey", None, None)
            .unwrap()
            .is_empty());

        std::fs::remove_dir_all(c.vault.parent().unwrap()).ok();
    }
}
