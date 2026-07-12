//! Canvas files (`.canvas`): portable spatial documents stored as plain files
//! in the vault, using the widely-adopted Obsidian JSON Canvas format. The core
//! treats a canvas as opaque JSON text — it lists, reads, writes, creates and
//! deletes the files with the same path guards and atomic writes as notes, and
//! never parses the document itself (the frontend owns the schema). Leaving the
//! bytes untouched keeps canvases fully portable and round-trip faithful, so a
//! canvas authored in another editor (or a future field we don't model yet)
//! survives an open/save cycle unchanged.

use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;
use walkdir::WalkDir;

use crate::error::{CoreError, CoreResult};
use crate::vault::fs::{vault_rel, write_atomic};

/// The vault file extension for a canvas document.
pub const CANVAS_EXT: &str = "canvas";

/// A `.canvas` file discovered in the vault.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CanvasFile {
    /// Vault-relative, forward-slashed path (e.g. `boards/plan.canvas`).
    pub path: String,
    /// Display name — the file stem, without the `.canvas` extension.
    pub name: String,
}

/// Whether a path component should be skipped (hidden files/folders, incl.
/// `.novalis`) — mirrors the note walker.
fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

/// Reject a path that is not a `.canvas` file, so the canvas commands can never
/// be turned into a way to read or clobber notes or other vault files.
fn ensure_canvas(relative: &str) -> CoreResult<()> {
    let is_canvas = Path::new(relative)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case(CANVAS_EXT));
    if is_canvas {
        Ok(())
    } else {
        Err(CoreError::BadRequest(format!(
            "Not a canvas file: {relative}"
        )))
    }
}

/// List every `.canvas` file in the vault, sorted by path. Skips hidden
/// files/folders and the root `media` directory, matching the note walker so a
/// canvas can never be indexed from `media/` or a `.trash` copy.
pub fn list(vault: &Path) -> Vec<CanvasFile> {
    let mut out = Vec::new();

    for entry in WalkDir::new(vault)
        .into_iter()
        .filter_entry(|e| {
            // Never prune the vault root itself (depth 0) — its directory name
            // is outside our control and may legitimately start with a dot.
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
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
        if path.extension().and_then(|e| e.to_str()) != Some(CANVAS_EXT) {
            continue;
        }

        let relative = path
            .strip_prefix(vault)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let name = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        out.push(CanvasFile {
            path: relative,
            name,
        });
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Read a canvas file's raw JSON content.
pub fn read(vault: &Path, relative: &str) -> CoreResult<String> {
    ensure_canvas(relative)?;
    let abs = vault_rel(vault, relative)?;
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Canvas not found: {relative}")));
    }
    Ok(std::fs::read_to_string(&abs)?)
}

/// Overwrite an existing canvas file atomically. Errors if it does not exist,
/// so a stale path from a closed vault can't silently resurrect a deleted
/// canvas.
pub fn write(vault: &Path, relative: &str, content: &str) -> CoreResult<()> {
    ensure_canvas(relative)?;
    let abs = vault_rel(vault, relative)?;
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Canvas not found: {relative}")));
    }
    write_atomic(&abs, content)
}

/// Create a new canvas file with initial JSON `content`. Errors if a file
/// already exists at that path. Creates any missing parent directories.
pub fn create(vault: &Path, relative: &str, content: &str) -> CoreResult<CanvasFile> {
    ensure_canvas(relative)?;
    let abs = vault_rel(vault, relative)?;
    if abs.exists() {
        return Err(CoreError::AlreadyExists(format!(
            "Canvas already exists: {relative}"
        )));
    }
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_atomic(&abs, content)?;

    let name = abs
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    Ok(CanvasFile {
        path: relative.to_string(),
        name,
    })
}

/// Permanently delete a canvas file.
pub fn delete(vault: &Path, relative: &str) -> CoreResult<()> {
    ensure_canvas(relative)?;
    let abs = vault_rel(vault, relative)?;
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Canvas not found: {relative}")));
    }
    std::fs::remove_file(&abs)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn create_read_write_roundtrip_preserves_bytes() {
        let tmp = temp_vault();
        let vault = tmp.path();
        // Arbitrary JSON, including a field the app doesn't model, must survive
        // untouched — canvases are opaque to the core.
        let original = "{\n  \"nodes\": [],\n  \"edges\": [],\n  \"customExt\": 42\n}";
        let file = create(vault, "board.canvas", original).unwrap();
        assert_eq!(file.path, "board.canvas");
        assert_eq!(file.name, "board");
        assert_eq!(read(vault, "board.canvas").unwrap(), original);

        let updated = "{\"nodes\":[{\"id\":\"a\"}],\"edges\":[]}";
        write(vault, "board.canvas", updated).unwrap();
        assert_eq!(read(vault, "board.canvas").unwrap(), updated);
    }

    #[test]
    fn create_rejects_duplicate_and_write_requires_existing() {
        let tmp = temp_vault();
        let vault = tmp.path();
        create(vault, "a.canvas", "{}").unwrap();
        assert!(matches!(
            create(vault, "a.canvas", "{}"),
            Err(CoreError::AlreadyExists(_))
        ));
        // Writing a canvas that was never created is a not-found, not a silent
        // create — a stale path must not resurrect a deleted file.
        assert!(matches!(
            write(vault, "missing.canvas", "{}"),
            Err(CoreError::NotFound(_))
        ));
        assert!(matches!(
            read(vault, "missing.canvas"),
            Err(CoreError::NotFound(_))
        ));
    }

    #[test]
    fn non_canvas_extension_is_rejected() {
        let tmp = temp_vault();
        let vault = tmp.path();
        // The canvas commands must never touch notes or other files.
        for bad in ["note.md", "plain.txt", "noext", "canvas"] {
            assert!(
                matches!(create(vault, bad, "{}"), Err(CoreError::BadRequest(_))),
                "create must reject {bad}"
            );
            assert!(
                matches!(read(vault, bad), Err(CoreError::BadRequest(_))),
                "read must reject {bad}"
            );
            assert!(
                matches!(write(vault, bad, "{}"), Err(CoreError::BadRequest(_))),
                "write must reject {bad}"
            );
            assert!(
                matches!(delete(vault, bad), Err(CoreError::BadRequest(_))),
                "delete must reject {bad}"
            );
        }
    }

    #[test]
    fn path_traversal_is_rejected() {
        let tmp = temp_vault();
        let vault = tmp.path();
        for bad in ["../escape.canvas", "foo/../../bar.canvas"] {
            assert!(read(vault, bad).is_err(), "read must reject {bad}");
            assert!(write(vault, bad, "{}").is_err(), "write must reject {bad}");
            assert!(
                create(vault, bad, "{}").is_err(),
                "create must reject {bad}"
            );
            assert!(delete(vault, bad).is_err(), "delete must reject {bad}");
        }
    }

    #[test]
    fn list_finds_canvases_and_skips_notes_hidden_and_media() {
        let tmp = temp_vault();
        let vault = tmp.path();
        std::fs::create_dir_all(vault.join("boards")).unwrap();
        std::fs::create_dir_all(vault.join("media")).unwrap();
        std::fs::create_dir_all(vault.join(".novalis")).unwrap();

        create(vault, "top.canvas", "{}").unwrap();
        create(vault, "boards/plan.canvas", "{}").unwrap();
        std::fs::write(vault.join("note.md"), "x").unwrap();
        // A canvas under media/ or a hidden dir must not be listed.
        std::fs::write(vault.join("media/pic.canvas"), "{}").unwrap();
        std::fs::write(vault.join(".novalis/hidden.canvas"), "{}").unwrap();

        let found: Vec<String> = list(vault).into_iter().map(|c| c.path).collect();
        assert_eq!(found, vec!["boards/plan.canvas", "top.canvas"]);
    }

    #[test]
    fn delete_removes_the_file() {
        let tmp = temp_vault();
        let vault = tmp.path();
        create(vault, "gone.canvas", "{}").unwrap();
        delete(vault, "gone.canvas").unwrap();
        assert!(!vault.join("gone.canvas").exists());
        assert!(matches!(
            delete(vault, "gone.canvas"),
            Err(CoreError::NotFound(_))
        ));
    }
}
