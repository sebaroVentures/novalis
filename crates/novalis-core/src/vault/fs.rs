//! Vault filesystem operations: notes CRUD, folder tree, move/duplicate.
//! Pure functions over a `vault: &Path` — no shared state, fully testable.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

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

/// Whether `meta` describes a cloud-only placeholder — a file kept "online only"
/// by OneDrive/iCloud (Files On-Demand). Such a file has a logical size but no
/// data blocks allocated on disk, so a `read` would block on a network download.
/// We index these from metadata alone and pick up their content once they are
/// materialized locally; this keeps opening a cloud-synced vault from hanging on
/// (or eagerly downloading) every offloaded note.
///
/// Heuristic: `size > 0` with zero allocated blocks. On APFS even a 1-byte
/// materialized file occupies a block, so a real local file never reports zero.
#[cfg(unix)]
pub fn is_cloud_placeholder(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    meta.len() > 0 && meta.blocks() == 0
}

#[cfg(not(unix))]
pub fn is_cloud_placeholder(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Format a filesystem timestamp as RFC 3339, or empty string if unavailable.
fn system_time_rfc3339(t: std::io::Result<std::time::SystemTime>) -> String {
    t.map(|t| chrono::DateTime::<Utc>::from(t).to_rfc3339())
        .unwrap_or_default()
}

/// Filesystem modification time as milliseconds since the Unix epoch, or `None`
/// when unavailable. Same representation the sync manifest uses; consumed by the
/// incremental index scan to decide whether a note changed since it was indexed.
pub fn file_mtime_ms(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .map(|t| chrono::DateTime::<Utc>::from(t).timestamp_millis())
}

/// Join a caller-supplied relative path under `base` (the vault root or one of
/// its data dirs), rejecting anything that could escape it: absolute paths
/// (`PathBuf::join` REPLACES the base when the operand is absolute) and any
/// `..` component. The check is purely lexical — no `canonicalize` — so it
/// also holds for paths that don't exist yet (create/move destinations).
/// Every filesystem operation that receives a path over IPC must go through
/// this.
pub fn vault_rel(base: &Path, relative: &str) -> CoreResult<PathBuf> {
    let rel = Path::new(relative);
    let escapes = rel.is_absolute()
        || rel.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        });
    if escapes {
        return Err(CoreError::BadRequest(format!(
            "Path escapes vault: {relative}"
        )));
    }
    Ok(base.join(rel))
}

/// Write `contents` to `path` atomically: write into a same-directory hidden
/// temp file, fsync it, then rename over the destination. A crash mid-save
/// leaves either the old or the new content — never a truncated file. The
/// temp name is dot-prefixed so the walker, watcher, and index all ignore it.
pub fn write_atomic(path: &Path, contents: &str) -> CoreResult<()> {
    use std::io::Write;

    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| {
            CoreError::Internal(format!("no parent directory for {}", path.display()))
        })?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = parent.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));

    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(result?)
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

/// Walk the vault yielding every note's vault-relative path paired with its
/// filesystem metadata — a stat-only enumeration that never reads bodies and
/// never hydrates cloud-only files. Used by the incremental index scan to
/// compare on-disk mtimes without [`list_notes`]' per-file body reads.
pub fn walk_note_metadata(vault: &Path) -> Vec<(String, std::fs::Metadata)> {
    let mut out = Vec::new();
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
        // `entry.metadata()` reuses walkdir's already-fetched stat — no body read,
        // no cloud hydration.
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        out.push((to_relative(vault, path), meta));
    }
    out
}

/// Build a [`NoteSummary`] for a single note.
pub fn build_summary(vault: &Path, relative: &str) -> CoreResult<NoteSummary> {
    let abs = vault_rel(vault, relative)?;

    let filename = abs
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let folder = Path::new(relative)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();

    // Don't read cloud-only placeholders — it would block on a network download.
    // Summarize from filename + metadata; content fills in once materialized.
    let meta = std::fs::metadata(&abs)?;
    if is_cloud_placeholder(&meta) {
        let title = frontmatter::extract_title(&NoteFrontmatter::default(), "", &filename);
        return Ok(NoteSummary {
            path: relative.to_string(),
            title,
            folder,
            tags: Vec::new(),
            aliases: Vec::new(),
            created: String::new(),
            modified: system_time_rfc3339(meta.modified()),
            pinned: false,
            word_count: 0,
            task_total: 0,
            task_completed: 0,
            cloud_only: true,
        });
    }

    let content = std::fs::read_to_string(&abs)?;
    let (fm, body) = frontmatter::parse_frontmatter(&content);
    let title = frontmatter::extract_title(&fm, &body, &filename);
    let wc = frontmatter::word_count(&body);

    // M1: count checkboxes. The full task index (with metadata) arrives in M2.
    let (task_total, task_completed) = tasks::count(&content);

    // Frontmatter tags first, then inline `#tags` from the body (case-insensitive
    // de-dup so a body `#Work` doesn't double a frontmatter `work`).
    let mut tags = fm.tags.clone();
    for t in frontmatter::extract_body_tags(&body) {
        if !tags.iter().any(|x| x.eq_ignore_ascii_case(&t)) {
            tags.push(t);
        }
    }

    Ok(NoteSummary {
        path: relative.to_string(),
        title,
        folder,
        tags,
        aliases: fm.aliases.clone(),
        created: fm.created.clone(),
        modified: fm.modified.clone(),
        pinned: fm.pinned,
        word_count: wc,
        task_total,
        task_completed,
        cloud_only: false,
    })
}

/// Read a full note from disk.
pub fn read_note(vault: &Path, relative: &str) -> CoreResult<Note> {
    let abs = vault_rel(vault, relative)?;
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
    let properties = frontmatter::properties_from_extra(&fm.extra);

    Ok(Note {
        path: relative.to_string(),
        title,
        content,
        frontmatter: fm,
        word_count: wc,
        properties,
    })
}

/// Write content to a note, updating the modified timestamp.
pub fn write_note(vault: &Path, relative: &str, content: &str) -> CoreResult<()> {
    let abs = vault_rel(vault, relative)?;
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Note not found: {relative}")));
    }

    let updated = frontmatter::update_modified(content)?;
    write_atomic(&abs, &updated)?;
    Ok(())
}

/// Create a new note. Generates frontmatter with created/modified timestamps.
pub fn create_note(vault: &Path, relative: &str, content: &str) -> CoreResult<Note> {
    let abs = vault_rel(vault, relative)?;
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

    write_atomic(&abs, &final_content)?;
    read_note(vault, relative)
}

/// Append a single line to a note's body, creating the note (with default
/// frontmatter) if it does not yet exist. Does not re-index — the caller does.
pub fn append_line(vault: &Path, relative: &str, line: &str) -> CoreResult<()> {
    let abs = vault_rel(vault, relative)?;
    if !abs.exists() {
        create_note(vault, relative, "")?;
    }

    let mut content = std::fs::read_to_string(&abs)?;
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(line);
    content.push('\n');

    write_atomic(&abs, &content)?;
    Ok(())
}

/// Delete a note by moving it to the vault's trash (`.novalis/trash`).
pub fn delete_note(vault: &Path, relative: &str) -> CoreResult<()> {
    trash::trash_note(vault, relative)
}

/// Whether two paths refer to the same underlying file (e.g. `note.md` vs
/// `Note.md` on a case-insensitive filesystem). Paths that don't resolve are
/// never "the same file".
#[cfg(unix)]
fn is_same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(ma), Ok(mb)) => ma.dev() == mb.dev() && ma.ino() == mb.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn is_same_file(a: &Path, b: &Path) -> bool {
    // Windows: canonicalize resolves to the stored (on-disk) casing, so two
    // spellings of one file compare equal.
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// Move/rename a note.
pub fn move_note(vault: &Path, from: &str, to: &str) -> CoreResult<()> {
    let abs_from = vault_rel(vault, from)?;
    let abs_to = vault_rel(vault, to)?;

    if !abs_from.exists() {
        return Err(CoreError::NotFound(format!(
            "Source note not found: {from}"
        )));
    }
    // On a case-insensitive filesystem (APFS, NTFS) a case-only rename makes
    // the destination "exist" because it IS the source file — allow that; only
    // a genuinely different file at the destination is a collision.
    if abs_to.exists() && !is_same_file(&abs_from, &abs_to) {
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
    let abs = vault_rel(vault, relative)?;
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
///
/// Note summaries come from the caller-supplied index map (`path -> summary`,
/// see [`crate::index::list_summaries`]) so the tree is built by enumerating
/// directories only — never reading file contents. Directory enumeration does
/// not hydrate cloud-only files, so this stays fast on OneDrive/iCloud vaults.
/// A file missing from the index falls back to a single disk read.
pub fn list_folders(vault: &Path, summaries: &HashMap<String, NoteSummary>) -> FolderNode {
    build_folder_node(vault, vault, "", summaries)
}

fn build_folder_node(
    vault: &Path,
    dir: &Path,
    rel_path: &str,
    summaries: &HashMap<String, NoteSummary>,
) -> FolderNode {
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
                children.push(build_folder_node(
                    vault,
                    &entry.path(),
                    &child_rel,
                    summaries,
                ));
            } else if ft.is_file() && fname.ends_with(".md") {
                let note_rel = if rel_path.is_empty() {
                    fname.clone()
                } else {
                    format!("{rel_path}/{fname}")
                };
                // Prefer the index summary (no disk read); fall back to reading
                // the file only for notes not yet indexed.
                match summaries.get(&note_rel) {
                    Some(summary) => notes.push(summary.clone()),
                    None => match build_summary(vault, &note_rel) {
                        Ok(summary) => notes.push(summary),
                        Err(e) => log::warn!("skipping {note_rel}: {e}"),
                    },
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
    let abs = vault_rel(vault, relative)?;
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
    let abs = vault_rel(vault, relative)?;
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
    let abs_from = vault_rel(vault, from)?;
    let abs_to = vault_rel(vault, to)?;

    if !abs_from.exists() {
        return Err(CoreError::NotFound(format!(
            "Source folder not found: {from}"
        )));
    }
    // On case-insensitive filesystems `exists()` is true for a case-only
    // rename (`notes/` -> `Notes/`) because it's the same directory — allow
    // that; only a genuinely different directory is a collision.
    if abs_to.exists() && !is_same_file(&abs_from, &abs_to) {
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

    fn temp_vault() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn write_atomic_writes_complete_content_and_replaces_existing() {
        let tmp = temp_vault();
        let vault = tmp.path().to_path_buf();
        let p = vault.join("a.md");
        write_atomic(&p, "first content").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "first content");
        // Replaces existing content wholesale.
        write_atomic(&p, "second").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "second");
        // No temp files are left behind.
        let leftovers: Vec<String> = std::fs::read_dir(&vault)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n != "a.md")
            .collect();
        assert!(leftovers.is_empty(), "unexpected files: {leftovers:?}");
        std::fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn write_note_fails_loud_on_malformed_frontmatter() {
        let tmp = temp_vault();
        let vault = tmp.path().to_path_buf();
        // `tags` must be a sequence — this deserializes to an error, and a
        // lenient parse would fall back to default frontmatter, erasing
        // `title` (and any custom keys) on re-serialize.
        let broken = "---\ntitle: Keep Me\ntags: notalist\n---\nbody\n";
        std::fs::write(vault.join("broken.md"), broken).unwrap();

        assert!(write_note(&vault, "broken.md", broken).is_err());
        // The file is left byte-identical.
        assert_eq!(
            std::fs::read_to_string(vault.join("broken.md")).unwrap(),
            broken
        );
        std::fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn write_note_saves_valid_and_frontmatterless_content() {
        let tmp = temp_vault();
        let vault = tmp.path().to_path_buf();
        create_note(&vault, "ok.md", "---\ntitle: Ok\n---\nold").unwrap();
        write_note(
            &vault,
            "ok.md",
            "---\ntitle: Ok\ntags:\n  - a\n---\nnew body",
        )
        .unwrap();
        let content = std::fs::read_to_string(vault.join("ok.md")).unwrap();
        assert!(content.contains("new body"));
        assert!(content.contains("title: Ok"));
        // Content without any frontmatter block still saves (default added).
        write_note(&vault, "ok.md", "just a body").unwrap();
        let content = std::fs::read_to_string(vault.join("ok.md")).unwrap();
        assert!(content.contains("just a body"));
        std::fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn vault_rel_rejects_escaping_paths() {
        let tmp = temp_vault();
        let vault = tmp.path().to_path_buf();
        std::fs::write(vault.join("real.md"), "x").unwrap();

        // Parent traversal, an absolute path (which `PathBuf::join` would let
        // REPLACE the vault base), and a mid-path `..` are all rejected.
        let outside = std::env::temp_dir().join(format!("novalis-esc-{}.md", uuid::Uuid::new_v4()));
        let abs_str = outside.to_string_lossy().to_string();
        for bad in ["../escape.md", abs_str.as_str(), "foo/../../bar.md"] {
            assert!(
                vault_rel(&vault, bad).is_err(),
                "vault_rel must reject {bad}"
            );
            assert!(
                read_note(&vault, bad).is_err(),
                "read_note must reject {bad}"
            );
            assert!(
                write_note(&vault, bad, "pwned").is_err(),
                "write_note must reject {bad}"
            );
            assert!(
                create_note(&vault, bad, "pwned").is_err(),
                "create_note must reject {bad}"
            );
            assert!(append_line(&vault, bad, "- [ ] x").is_err());
            assert!(
                move_note(&vault, "real.md", bad).is_err(),
                "move_note must reject destination {bad}"
            );
            assert!(move_note(&vault, bad, "elsewhere.md").is_err());
            assert!(create_folder(&vault, bad).is_err());
        }
        // Nothing was created outside the vault, and the source never moved.
        assert!(!outside.exists());
        assert!(vault.join("real.md").exists());
        std::fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn vault_rel_allows_nested_and_unicode_paths() {
        let tmp = temp_vault();
        let vault = tmp.path().to_path_buf();
        let rel = "Ordner/Unter/Über Nötes ✅.md";
        create_note(&vault, rel, "hällo wörld").unwrap();
        assert!(read_note(&vault, rel)
            .unwrap()
            .content
            .contains("hällo wörld"));
        write_note(&vault, rel, "---\ntitle: Ü\n---\nneu").unwrap();
        assert!(read_note(&vault, rel).unwrap().content.contains("neu"));
        std::fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn append_line_creates_note_when_missing() {
        let vault = temp_vault();
        append_line(vault.path(), "_Inbox.md", "- [ ] hello").unwrap();
        let content = std::fs::read_to_string(vault.path().join("_Inbox.md")).unwrap();
        assert!(
            content.starts_with("---"),
            "expected frontmatter, got: {content}"
        );
        assert!(content.contains("- [ ] hello"));
        assert!(content.ends_with('\n'));
    }

    #[test]
    fn append_line_preserves_existing_content() {
        let vault = temp_vault();
        std::fs::write(
            vault.path().join("notes.md"),
            "---\ntitle: X\n---\n\n# X\n\nbody line\n",
        )
        .unwrap();
        append_line(vault.path(), "notes.md", "- [ ] new task").unwrap();
        let content = std::fs::read_to_string(vault.path().join("notes.md")).unwrap();
        assert!(content.contains("body line"));
        assert!(content.trim_end().ends_with("- [ ] new task"));
        assert!(content.ends_with('\n'));
    }

    #[test]
    fn real_file_is_not_a_cloud_placeholder() {
        // A materialized file always has blocks allocated, so the placeholder
        // heuristic must not flag it (which would skip indexing its content).
        let vault = temp_vault();
        std::fs::write(vault.path().join("note.md"), "---\ntitle: N\n---\nhello").unwrap();
        let meta = std::fs::metadata(vault.path().join("note.md")).unwrap();
        assert!(!is_cloud_placeholder(&meta));
        // An empty file (size 0) is read normally, not treated as a placeholder.
        std::fs::write(vault.path().join("empty.md"), "").unwrap();
        let empty_meta = std::fs::metadata(vault.path().join("empty.md")).unwrap();
        assert!(!is_cloud_placeholder(&empty_meta));
    }

    #[test]
    fn create_read_roundtrip_with_task_counts() {
        let vault = temp_vault();
        create_note(vault.path(), "todo.md", "- [ ] a\n- [x] b\n").unwrap();
        let summary = build_summary(vault.path(), "todo.md").unwrap();
        assert_eq!(summary.task_total, 2);
        assert_eq!(summary.task_completed, 1);
        let note = read_note(vault.path(), "todo.md").unwrap();
        assert!(note.content.contains("- [x] b"));
    }

    #[test]
    fn build_summary_unions_frontmatter_and_body_tags() {
        let vault = temp_vault();
        std::fs::write(
            vault.path().join("n.md"),
            "---\ntitle: N\ntags:\n  - work\n---\n\nbody with #urgent and #Work\n",
        )
        .unwrap();
        let summary = build_summary(vault.path(), "n.md").unwrap();
        // Frontmatter tag first; body `#urgent` appended; body `#Work`
        // case-insensitively dedups against the frontmatter `work`.
        assert_eq!(summary.tags, vec!["work".to_string(), "urgent".to_string()]);
    }

    #[test]
    fn move_note_allows_case_only_rename() {
        // On a case-insensitive filesystem (APFS/NTFS) the destination of a
        // case-only rename "exists" — it is the source file — and must not be
        // treated as a collision.
        let vault = temp_vault();
        std::fs::write(vault.path().join("note.md"), "body").unwrap();

        move_note(vault.path(), "note.md", "Note.md").unwrap();

        let names: Vec<String> = std::fs::read_dir(vault.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["Note.md".to_string()]);
        assert_eq!(
            std::fs::read_to_string(vault.path().join("Note.md")).unwrap(),
            "body"
        );
    }

    #[test]
    fn move_folder_allows_case_only_rename_but_rejects_collisions() {
        // Same case-insensitive-filesystem rule as move_note, for folders.
        let vault = temp_vault();
        std::fs::create_dir_all(vault.path().join("notes")).unwrap();
        std::fs::write(vault.path().join("notes/a.md"), "a").unwrap();

        move_folder(vault.path(), "notes", "Notes").unwrap();

        let names: Vec<String> = std::fs::read_dir(vault.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["Notes".to_string()]);
        assert_eq!(
            std::fs::read_to_string(vault.path().join("Notes/a.md")).unwrap(),
            "a"
        );

        // A genuinely different existing directory is still a collision.
        std::fs::create_dir_all(vault.path().join("Other")).unwrap();
        assert!(matches!(
            move_folder(vault.path(), "Notes", "Other"),
            Err(CoreError::AlreadyExists(_))
        ));
    }

    #[test]
    fn move_note_still_rejects_a_genuine_collision() {
        let vault = temp_vault();
        std::fs::write(vault.path().join("a.md"), "a").unwrap();
        std::fs::write(vault.path().join("b.md"), "b").unwrap();

        let err = move_note(vault.path(), "a.md", "b.md").unwrap_err();
        assert!(matches!(err, CoreError::AlreadyExists(_)), "got: {err:?}");
        // Both files are untouched.
        assert_eq!(
            std::fs::read_to_string(vault.path().join("a.md")).unwrap(),
            "a"
        );
        assert_eq!(
            std::fs::read_to_string(vault.path().join("b.md")).unwrap(),
            "b"
        );
    }
}
