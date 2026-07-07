//! Soft-delete: notes are moved into the vault's `.novalis/trash/` with a
//! `.meta` sidecar recording their original vault-relative path, so they can be
//! restored. Living inside the vault means trash syncs (OneDrive/iCloud): it
//! survives a reinstall and is recoverable on any device. The `.novalis/` folder
//! is hidden from the index and the file watcher, so trashed notes never appear
//! in search or the tree.

use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::{CoreError, CoreResult};
use crate::vault::config;
use crate::vault::fs::vault_rel;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub id: String,
    pub original_path: String,
    pub trashed_at: String,
    pub filename: String,
}

/// The trash directory inside a vault (`<vault>/.novalis/trash`).
fn trash_root(vault: &Path) -> PathBuf {
    config::config_dir(vault).join("trash")
}

/// Collision-proof trash id. The timestamp prefix stays first (and 15 chars)
/// because `list_trash` parses it back out for sorting/display; the uuid keeps
/// two same-named items trashed within the same second from overwriting each
/// other in the trash directory.
fn new_trash_id(name: &str) -> String {
    let now = Utc::now().format("%Y%m%d_%H%M%S");
    let unique = uuid::Uuid::new_v4().simple();
    format!("{now}_{unique}_{name}")
}

/// Move a note to the vault's trash.
pub fn trash_note(vault: &Path, relative: &str) -> CoreResult<()> {
    let abs = vault_rel(vault, relative)?;
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Note not found: {relative}")));
    }

    let trash_dir = trash_root(vault);
    std::fs::create_dir_all(&trash_dir)?;

    let filename = abs
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let trash_id = new_trash_id(&filename);
    let trash_file = trash_dir.join(&trash_id);
    let meta_file = trash_dir.join(format!("{trash_id}.meta"));

    std::fs::rename(&abs, &trash_file)?;
    std::fs::write(&meta_file, relative)?;

    log::info!("trashed {relative} -> {trash_id}");
    Ok(())
}

/// Move an entire folder (and its contents) to trash. The whole subtree is
/// relocated under a single trash id; the `.meta` sidecar stores the original
/// vault-relative folder path so it can be restored as a unit.
pub fn trash_folder(vault: &Path, relative: &str) -> CoreResult<()> {
    let abs = vault_rel(vault, relative)?;
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Folder not found: {relative}")));
    }

    let trash_dir = trash_root(vault);
    std::fs::create_dir_all(&trash_dir)?;

    let name = abs
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    let trash_id = new_trash_id(&name);
    let trash_path = trash_dir.join(&trash_id);
    let meta_file = trash_dir.join(format!("{trash_id}.meta"));

    // `rename` moves the whole subtree atomically (same filesystem).
    std::fs::rename(&abs, &trash_path)?;
    std::fs::write(&meta_file, relative)?;

    log::info!("trashed folder {relative} -> {trash_id}");
    Ok(())
}

/// List all items in the trash, newest first.
pub fn list_trash(vault: &Path) -> CoreResult<Vec<TrashItem>> {
    let trash_dir = trash_root(vault);
    if !trash_dir.exists() {
        return Ok(Vec::new());
    }

    let mut items = Vec::new();

    for entry in std::fs::read_dir(&trash_dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip .meta files — read them alongside the main file.
        if name.ends_with(".meta") {
            continue;
        }

        let meta_path = trash_dir.join(format!("{name}.meta"));
        let original_path = if meta_path.exists() {
            std::fs::read_to_string(&meta_path).unwrap_or_default()
        } else {
            name.clone()
        };

        // Parse timestamp from the id (first 15 chars: YYYYMMDD_HHMMSS).
        let trashed_at = if name.len() >= 15 {
            name[..15].to_string()
        } else {
            String::new()
        };

        items.push(TrashItem {
            id: name.clone(),
            original_path,
            trashed_at,
            filename: name,
        });
    }

    items.sort_by(|a, b| b.trashed_at.cmp(&a.trashed_at));
    Ok(items)
}

/// Restore a trashed note to its original location. Returns the restored path.
pub fn restore_note(vault: &Path, trash_id: &str) -> CoreResult<String> {
    let trash_dir = trash_root(vault);
    let trash_file = vault_rel(&trash_dir, trash_id)?;
    let meta_file = vault_rel(&trash_dir, &format!("{trash_id}.meta"))?;

    if !trash_file.exists() {
        return Err(CoreError::NotFound(format!(
            "Trash item not found: {trash_id}"
        )));
    }

    let original_path = if meta_file.exists() {
        std::fs::read_to_string(&meta_file)?
    } else {
        trash_id.to_string()
    };

    // The `.meta` sidecar could have been tampered with by a sync peer —
    // never restore outside the vault.
    let restore_to = vault_rel(vault, &original_path)?;
    if restore_to.exists() {
        return Err(CoreError::AlreadyExists(format!(
            "Restore target already exists: {original_path}"
        )));
    }
    if let Some(parent) = restore_to.parent() {
        std::fs::create_dir_all(parent)?;
    }

    std::fs::rename(&trash_file, &restore_to)?;

    if meta_file.exists() {
        let _ = std::fs::remove_file(&meta_file);
    }

    log::info!("restored {trash_id} -> {original_path}");
    Ok(original_path)
}

/// Permanently delete a single trash item (and its `.meta` sidecar).
pub fn delete_trash_item(vault: &Path, trash_id: &str) -> CoreResult<()> {
    let trash_dir = trash_root(vault);
    let item = vault_rel(&trash_dir, trash_id)?;
    let meta = vault_rel(&trash_dir, &format!("{trash_id}.meta"))?;

    if item.is_dir() {
        std::fs::remove_dir_all(&item)?;
    } else if item.exists() {
        std::fs::remove_file(&item)?;
    } else {
        return Err(CoreError::NotFound(format!(
            "Trash item not found: {trash_id}"
        )));
    }
    if meta.exists() {
        let _ = std::fs::remove_file(&meta);
    }
    log::info!("permanently deleted {trash_id}");
    Ok(())
}

/// Permanently delete all items in the trash. Returns count of notes deleted.
pub fn empty_trash(vault: &Path) -> CoreResult<usize> {
    let trash_dir = trash_root(vault);
    if !trash_dir.exists() {
        return Ok(0);
    }

    let mut count = 0;
    for entry in std::fs::read_dir(&trash_dir)? {
        let entry = entry?;
        let is_meta = entry.file_name().to_string_lossy().ends_with(".meta");
        // Trashed folders are directories (see `trash_folder`); notes/meta are files.
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
        if !is_meta {
            count += 1;
        }
    }

    log::info!("emptied trash: {count} items permanently deleted");
    Ok(count)
}

/// One-time migration: relocate any app-local trash (`<data_dir>/trash`, the old
/// location) into the vault. No-op if the legacy dir is absent or the vault
/// trash already has items. Best-effort; falls back to copy across filesystems.
pub fn migrate_legacy_trash(vault: &Path, data_dir: &Path) -> CoreResult<()> {
    let legacy = data_dir.join("trash");
    if !legacy.exists() {
        return Ok(());
    }
    let dest = trash_root(vault);
    let dest_has_items = std::fs::read_dir(&dest)
        .map(|mut r| r.next().is_some())
        .unwrap_or(false);
    if dest_has_items {
        return Ok(());
    }
    std::fs::create_dir_all(&dest)?;

    for entry in std::fs::read_dir(&legacy)? {
        let entry = entry?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if std::fs::rename(&from, &to).is_err() {
            // Cross-filesystem: copy then remove.
            copy_recursive(&from, &to)?;
            if entry.file_type()?.is_dir() {
                let _ = std::fs::remove_dir_all(&from);
            } else {
                let _ = std::fs::remove_file(&from);
            }
        }
    }
    let _ = std::fs::remove_dir_all(&legacy);
    log::info!("migrated legacy app-data trash into the vault");
    Ok(())
}

fn copy_recursive(from: &Path, to: &Path) -> CoreResult<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(from, to)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> (tempfile::TempDir, PathBuf) {
        let base = tempfile::tempdir().unwrap();
        let vault = base.path().join("vault");
        std::fs::create_dir_all(&vault).unwrap();
        (base, vault)
    }

    #[test]
    fn trash_lives_inside_the_vault() {
        let (_tmp, vault) = temp_vault();
        std::fs::write(vault.join("loose.md"), "y").unwrap();
        trash_note(&vault, "loose.md").unwrap();
        assert!(
            vault.join(".novalis/trash").exists(),
            "trash should live under <vault>/.novalis/trash"
        );
        assert!(!vault.join("loose.md").exists());
    }

    #[test]
    fn same_second_double_trash_keeps_both() {
        let (_tmp, vault) = temp_vault();
        std::fs::write(vault.join("a.md"), "root").unwrap();
        std::fs::create_dir_all(vault.join("sub")).unwrap();
        std::fs::write(vault.join("sub/a.md"), "nested").unwrap();

        // Same filename, (almost certainly) the same second: the ids must not
        // collide, so neither copy silently overwrites the other in the trash.
        trash_note(&vault, "a.md").unwrap();
        trash_note(&vault, "sub/a.md").unwrap();

        let items = list_trash(&vault).unwrap();
        assert_eq!(items.len(), 2, "both same-named notes must survive");
        let mut paths: Vec<_> = items.iter().map(|i| i.original_path.clone()).collect();
        paths.sort();
        assert_eq!(paths, ["a.md", "sub/a.md"]);
    }

    #[test]
    fn restore_onto_occupied_path_fails_without_clobbering() {
        let (_tmp, vault) = temp_vault();
        std::fs::write(vault.join("n.md"), "old").unwrap();
        trash_note(&vault, "n.md").unwrap();
        // A new note has since been created at the original path.
        std::fs::write(vault.join("n.md"), "new").unwrap();

        let items = list_trash(&vault).unwrap();
        let err = restore_note(&vault, &items[0].id).unwrap_err();
        assert!(matches!(err, CoreError::AlreadyExists(_)), "got: {err:?}");
        // Loud failure, no clobbering: the live note is untouched and the
        // trashed copy is still there to restore elsewhere.
        assert_eq!(std::fs::read_to_string(vault.join("n.md")).unwrap(), "new");
        assert_eq!(list_trash(&vault).unwrap().len(), 1);
    }

    #[test]
    fn trash_rejects_escaping_paths_and_tampered_meta() {
        let (_tmp, vault) = temp_vault();
        assert!(trash_note(&vault, "../outside.md").is_err());
        assert!(trash_folder(&vault, "/etc").is_err());
        assert!(delete_trash_item(&vault, "../real.md").is_err());

        // A `.meta` sidecar pointing outside the vault must not be restorable
        // to that location.
        std::fs::write(vault.join("victim.md"), "x").unwrap();
        trash_note(&vault, "victim.md").unwrap();
        let items = list_trash(&vault).unwrap();
        let meta = vault
            .join(".novalis/trash")
            .join(format!("{}.meta", items[0].id));
        std::fs::write(&meta, "../escaped.md").unwrap();
        assert!(restore_note(&vault, &items[0].id).is_err());
        assert!(!vault.parent().unwrap().join("escaped.md").exists());
        // Restoring by an escaping trash id is rejected too.
        assert!(restore_note(&vault, "../victim.md").is_err());
    }

    #[test]
    fn trash_folder_moves_subtree_and_restores_as_unit() {
        let (_tmp, vault) = temp_vault();
        std::fs::create_dir_all(vault.join("Projects/Sub")).unwrap();
        std::fs::write(vault.join("Projects/a.md"), "a").unwrap();
        std::fs::write(vault.join("Projects/Sub/b.md"), "b").unwrap();

        trash_folder(&vault, "Projects").unwrap();
        assert!(
            !vault.join("Projects").exists(),
            "folder should leave the vault"
        );

        let items = list_trash(&vault).unwrap();
        assert_eq!(items.len(), 1, "trashed folder is a single entry");
        assert_eq!(items[0].original_path, "Projects");

        let restored = restore_note(&vault, &items[0].id).unwrap();
        assert_eq!(restored, "Projects");
        assert!(vault.join("Projects/a.md").exists());
        assert!(vault.join("Projects/Sub/b.md").exists());
    }

    #[test]
    fn delete_trash_item_removes_one_entry() {
        let (_tmp, vault) = temp_vault();
        std::fs::write(vault.join("a.md"), "a").unwrap();
        std::fs::write(vault.join("b.md"), "b").unwrap();
        trash_note(&vault, "a.md").unwrap();
        trash_note(&vault, "b.md").unwrap();

        let items = list_trash(&vault).unwrap();
        assert_eq!(items.len(), 2);
        delete_trash_item(&vault, &items[0].id).unwrap();
        assert_eq!(list_trash(&vault).unwrap().len(), 1);
    }

    #[test]
    fn empty_trash_removes_trashed_folders() {
        let (_tmp, vault) = temp_vault();
        std::fs::create_dir_all(vault.join("Archive")).unwrap();
        std::fs::write(vault.join("Archive/note.md"), "x").unwrap();
        std::fs::write(vault.join("loose.md"), "y").unwrap();

        trash_folder(&vault, "Archive").unwrap();
        trash_note(&vault, "loose.md").unwrap();

        // 2 items (a directory + a file); empty_trash must handle both.
        let count = empty_trash(&vault).unwrap();
        assert_eq!(count, 2);
        assert_eq!(list_trash(&vault).unwrap().len(), 0);
    }

    #[test]
    fn migrate_legacy_trash_moves_items_into_the_vault() {
        let (tmp, vault) = temp_vault();
        let data = tmp.path().join("data");
        // Seed an old app-data trash item.
        let legacy = data.join("trash");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("20250101_000000_old.md"), "old").unwrap();
        std::fs::write(legacy.join("20250101_000000_old.md.meta"), "old.md").unwrap();

        migrate_legacy_trash(&vault, &data).unwrap();

        assert!(!legacy.exists(), "legacy trash dir should be removed");
        let items = list_trash(&vault).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].original_path, "old.md");
    }
}
