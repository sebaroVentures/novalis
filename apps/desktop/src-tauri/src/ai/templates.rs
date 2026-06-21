//! Storage for user-defined AI prompt templates, kept as `.md` files. The file
//! name (without extension) is the display name; the contents are the prompt.
//! Each template is either **global** (app config dir — every vault) or
//! **vault** (`<vault>/.novalis/ai-prompts/`, synced with the vault via git like
//! `config.json`). Plain files the user can open, edit, and share. These
//! functions operate on an already-resolved directory; the caller picks it.

use std::path::{Path, PathBuf};

use novalis_core::models::{AiTemplate, AiTemplateScope};
use novalis_core::vault::config::CONFIG_DIR;

use crate::engine::CommandError;

/// Sub-directory name used under both the app config dir and a vault's
/// `.novalis/`.
pub const SUBDIR: &str = "ai-prompts";

/// The per-vault templates directory.
pub fn vault_dir(vault: &Path) -> PathBuf {
    vault.join(CONFIG_DIR).join(SUBDIR)
}

/// Turn a display name into a safe single-segment file name (no path parts).
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Templates in `dir`, each tagged with `scope`. Missing folder → empty list.
pub fn list(dir: &Path, scope: AiTemplateScope) -> Result<Vec<AiTemplate>, CommandError> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let name = path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or(file_name)
            .to_string();
        let body = std::fs::read_to_string(&path).unwrap_or_default();
        out.push(AiTemplate {
            id: file_name.to_string(),
            name,
            body,
            scope,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Create or overwrite the template named `name` with `body` in `dir`.
pub fn save(dir: &Path, name: &str, body: &str) -> Result<(), CommandError> {
    std::fs::create_dir_all(dir)
        .map_err(|e| CommandError::internal(format!("create ai-prompts dir: {e}")))?;
    let path = dir.join(format!("{}.md", sanitize(name)));
    std::fs::write(&path, body).map_err(|e| CommandError::internal(format!("write template: {e}")))
}

/// Delete the template with file name `id` in `dir`. No-op if already gone.
pub fn delete(dir: &Path, id: &str) -> Result<(), CommandError> {
    // Only ever touch a bare file name inside the templates dir (no traversal).
    let Some(file) = Path::new(id).file_name().and_then(|n| n.to_str()) else {
        return Ok(());
    };
    let path = dir.join(file);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(CommandError::internal(format!("delete template: {e}"))),
    }
}
