//! Local, app-data version history for notes.
//!
//! On each content save we snapshot the *previous* on-disk content under
//! `<data_dir>/versions/<encoded-path>/<timestamp>.md`, then prune by count and
//! age. Snapshots are **throttled** (checkpoints, not keystrokes) and
//! **de-duplicated** (never store a copy identical to the most recent one), so
//! 600 ms autosaves don't flood the store. History lives in app-data, never in
//! the synced vault — the vault stays clean Markdown.

use std::path::{Path, PathBuf};

use chrono::{DateTime, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::{CoreError, CoreResult};

/// Keep at most this many snapshots per note.
pub const MAX_VERSIONS: usize = 50;
/// Drop snapshots older than this many days.
pub const MAX_AGE_DAYS: i64 = 30;
/// Don't snapshot more often than this — history is coarse checkpoints, so a
/// burst of autosaves while typing collapses to one entry.
pub const MIN_INTERVAL_SECS: i64 = 180;

/// Metadata for one stored snapshot of a note.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VersionMeta {
    /// Snapshot id = its timestamped filename stem (`YYYYMMDD_HHMMSS_mmm`).
    pub id: String,
    /// When the snapshot was taken (RFC 3339, derived from the id).
    pub created_at: String,
    /// Byte size of the snapshot content.
    pub size: u32,
}

/// One line of a unified line-diff between a snapshot and the current note.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// `"equal"`, `"insert"`, or `"delete"`.
    pub kind: String,
    pub content: String,
}

/// Cap a string to ~1 MiB on a char boundary, so a huge note can't hang the diff.
fn cap(s: &str) -> String {
    const MAX: usize = 1024 * 1024;
    if s.len() <= MAX {
        return s.to_string();
    }
    let mut end = MAX;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// Line-diff a stored snapshot (old) against the current on-disk note (new) —
/// i.e. "what changed since this version". A missing current file diffs against
/// empty. Inputs are capped to keep the modal responsive.
pub fn diff(
    data_dir: &Path,
    vault: &Path,
    relative: &str,
    version_id: &str,
) -> CoreResult<Vec<DiffLine>> {
    let old = cap(&read_version(data_dir, relative, version_id)?);
    let new = cap(&std::fs::read_to_string(vault.join(relative)).unwrap_or_default());

    let text_diff = similar::TextDiff::from_lines(&old, &new);
    let mut out = Vec::new();
    for change in text_diff.iter_all_changes() {
        let kind = match change.tag() {
            similar::ChangeTag::Equal => "equal",
            similar::ChangeTag::Insert => "insert",
            similar::ChangeTag::Delete => "delete",
        };
        out.push(DiffLine {
            kind: kind.to_string(),
            content: change.value().trim_end_matches('\n').to_string(),
        });
    }
    Ok(out)
}

/// Encode a vault-relative note path into one filesystem-safe directory name.
/// `%`→`%25`, `/`→`%2F`, `\`→`%5C` — separator-free and collision-free. We never
/// decode it; we only need a stable key. (Very long paths could in theory exceed
/// a 255-byte filename; acceptable for note paths in practice.)
fn encode_path(relative: &str) -> String {
    relative
        .replace('%', "%25")
        .replace('/', "%2F")
        .replace('\\', "%5C")
}

fn version_dir(data_dir: &Path, relative: &str) -> PathBuf {
    data_dir.join("versions").join(encode_path(relative))
}

/// Snapshot files for a note as `(id, abs path)`, newest first. Ids are
/// zero-padded timestamps, so a reverse lexical sort is chronological.
fn snapshot_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(id) = name.strip_suffix(".md") {
                out.push((id.to_string(), entry.path()));
            }
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out
}

/// Parse the `YYYYMMDD_HHMMSS` prefix of a snapshot id into a UTC datetime.
fn id_time(id: &str) -> Option<DateTime<Utc>> {
    let stamp = id.get(..15)?;
    NaiveDateTime::parse_from_str(stamp, "%Y%m%d_%H%M%S")
        .ok()
        .map(|ndt| DateTime::<Utc>::from_naive_utc_and_offset(ndt, Utc))
}

/// Snapshot the current on-disk content of `relative` before it is overwritten.
/// Throttled + de-duplicated. Best-effort — callers ignore the error so a
/// snapshot failure never blocks a save.
pub fn snapshot(data_dir: &Path, vault: &Path, relative: &str) -> CoreResult<()> {
    snapshot_inner(data_dir, vault, relative, true)
}

/// Like [`snapshot`] but ignores the throttle — used by restore so the current
/// state is always captured first (the restore stays undoable).
pub fn snapshot_now(data_dir: &Path, vault: &Path, relative: &str) -> CoreResult<()> {
    snapshot_inner(data_dir, vault, relative, false)
}

fn snapshot_inner(data_dir: &Path, vault: &Path, relative: &str, throttle: bool) -> CoreResult<()> {
    let abs = vault.join(relative);
    if !abs.exists() {
        return Ok(());
    }
    let dir = version_dir(data_dir, relative);
    let existing = snapshot_files(&dir);
    let newest = existing.first();

    // Throttle first — it only parses the newest id (no file I/O), so an autosave
    // burst doesn't read the (possibly large) note content on every tick.
    if throttle {
        if let Some((newest_id, _)) = newest {
            if let Some(t) = id_time(newest_id) {
                if (Utc::now() - t).num_seconds() < MIN_INTERVAL_SECS {
                    return Ok(());
                }
            }
        }
    }

    let current = std::fs::read_to_string(&abs)?;

    // De-dup: never store a snapshot identical to the most recent one.
    if let Some((_, newest_path)) = newest {
        if std::fs::read_to_string(newest_path)
            .map(|prev| prev == current)
            .unwrap_or(false)
        {
            return Ok(());
        }
    }

    std::fs::create_dir_all(&dir)?;
    let id = Utc::now().format("%Y%m%d_%H%M%S_%3f").to_string();
    std::fs::write(dir.join(format!("{id}.md")), &current)?;
    prune(&dir);
    Ok(())
}

/// Keep the newest [`MAX_VERSIONS`] and drop anything older than [`MAX_AGE_DAYS`].
fn prune(dir: &Path) {
    let files = snapshot_files(dir);
    let cutoff = Utc::now() - chrono::Duration::days(MAX_AGE_DAYS);
    for (i, (id, path)) in files.iter().enumerate() {
        let too_many = i >= MAX_VERSIONS;
        let too_old = id_time(id).map(|t| t < cutoff).unwrap_or(false);
        if too_many || too_old {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// List a note's snapshots, newest first.
pub fn list_versions(data_dir: &Path, relative: &str) -> CoreResult<Vec<VersionMeta>> {
    let dir = version_dir(data_dir, relative);
    let mut items = Vec::new();
    for (id, path) in snapshot_files(&dir) {
        let size = std::fs::metadata(&path)
            .map(|m| m.len() as u32)
            .unwrap_or(0);
        let created_at = id_time(&id).map(|t| t.to_rfc3339()).unwrap_or_default();
        items.push(VersionMeta {
            id,
            created_at,
            size,
        });
    }
    Ok(items)
}

/// Read the content of one snapshot.
pub fn read_version(data_dir: &Path, relative: &str, version_id: &str) -> CoreResult<String> {
    let path = version_dir(data_dir, relative).join(format!("{version_id}.md"));
    if !path.exists() {
        return Err(CoreError::NotFound(format!(
            "Version not found: {version_id}"
        )));
    }
    Ok(std::fs::read_to_string(&path)?)
}

/// Move a note's version directory after a rename/move (best-effort — history
/// "detaches" if this fails, which is acceptable).
pub fn rename(data_dir: &Path, from: &str, to: &str) {
    let from_dir = version_dir(data_dir, from);
    if !from_dir.exists() {
        return;
    }
    let to_dir = version_dir(data_dir, to);
    if let Some(parent) = to_dir.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::rename(&from_dir, &to_dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dirs() -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("novalis-versions-{}", uuid::Uuid::new_v4()));
        let vault = base.join("vault");
        let data = base.join("data");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        (vault, data)
    }

    /// Place a snapshot file with an explicit id (to control its apparent age).
    fn seed_snapshot(data: &Path, rel: &str, id: &str, content: &str) {
        let dir = version_dir(data, rel);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.md")), content).unwrap();
    }

    #[test]
    fn snapshot_captures_pre_overwrite_content() {
        let (vault, data) = dirs();
        std::fs::write(vault.join("n.md"), "ORIGINAL").unwrap();
        // First snapshot (no history yet) captures the current on-disk content.
        snapshot(&data, &vault, "n.md").unwrap();
        let v = list_versions(&data, "n.md").unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(read_version(&data, "n.md", &v[0].id).unwrap(), "ORIGINAL");
        std::fs::remove_dir_all(vault.parent().unwrap()).ok();
    }

    #[test]
    fn diff_reports_inserts_deletes_and_equals() {
        let (vault, data) = dirs();
        seed_snapshot(&data, "n.md", "20200101_000000_000", "alpha\nbeta\n");
        std::fs::write(vault.join("n.md"), "alpha\ngamma\n").unwrap();
        let d = diff(&data, &vault, "n.md", "20200101_000000_000").unwrap();
        assert!(d.iter().any(|l| l.kind == "equal" && l.content == "alpha"));
        assert!(d.iter().any(|l| l.kind == "delete" && l.content == "beta"));
        assert!(d.iter().any(|l| l.kind == "insert" && l.content == "gamma"));
        std::fs::remove_dir_all(vault.parent().unwrap()).ok();
    }

    #[test]
    fn diff_identical_is_all_equal() {
        let (vault, data) = dirs();
        seed_snapshot(&data, "n.md", "20200101_000000_000", "same\n");
        std::fs::write(vault.join("n.md"), "same\n").unwrap();
        let d = diff(&data, &vault, "n.md", "20200101_000000_000").unwrap();
        assert!(!d.is_empty() && d.iter().all(|l| l.kind == "equal"));
        std::fs::remove_dir_all(vault.parent().unwrap()).ok();
    }

    #[test]
    fn dedup_skips_identical_consecutive_content() {
        let (vault, data) = dirs();
        std::fs::write(vault.join("n.md"), "SAME").unwrap();
        seed_snapshot(&data, "n.md", "20200101_000000_000", "SAME");
        // Throttle-free path still de-dups identical content.
        snapshot_now(&data, &vault, "n.md").unwrap();
        assert_eq!(list_versions(&data, "n.md").unwrap().len(), 1);
        std::fs::remove_dir_all(vault.parent().unwrap()).ok();
    }

    #[test]
    fn throttle_skips_recent_but_allows_after_interval() {
        let (vault, data) = dirs();
        std::fs::write(vault.join("n.md"), "NEW").unwrap();

        // A recent snapshot (now) blocks a throttled snapshot of different content.
        let recent = Utc::now().format("%Y%m%d_%H%M%S_%3f").to_string();
        seed_snapshot(&data, "n.md", &recent, "OLD");
        snapshot(&data, &vault, "n.md").unwrap();
        assert_eq!(
            list_versions(&data, "n.md").unwrap().len(),
            1,
            "throttle should skip a snapshot within MIN_INTERVAL_SECS"
        );

        // A newest snapshot older than the throttle interval (but within the age
        // window, so it isn't pruned) lets a throttled snapshot through.
        std::fs::remove_dir_all(version_dir(&data, "n.md")).unwrap();
        let hour_ago = (Utc::now() - chrono::Duration::hours(1))
            .format("%Y%m%d_%H%M%S_%3f")
            .to_string();
        seed_snapshot(&data, "n.md", &hour_ago, "OLD");
        snapshot(&data, &vault, "n.md").unwrap();
        assert_eq!(list_versions(&data, "n.md").unwrap().len(), 2);
        std::fs::remove_dir_all(vault.parent().unwrap()).ok();
    }

    #[test]
    fn prune_keeps_newest_max_versions() {
        let (_vault, data) = dirs();
        // Distinct, recent ids (seconds apart) so none are dropped by age.
        let now = Utc::now();
        for i in 0..(MAX_VERSIONS + 10) {
            let id = (now - chrono::Duration::seconds(i as i64))
                .format("%Y%m%d_%H%M%S_%3f")
                .to_string();
            seed_snapshot(&data, "n.md", &id, &format!("v{i}"));
        }
        prune(&version_dir(&data, "n.md"));
        assert_eq!(list_versions(&data, "n.md").unwrap().len(), MAX_VERSIONS);
        std::fs::remove_dir_all(data.parent().unwrap()).ok();
    }

    #[test]
    fn prune_drops_entries_older_than_max_age() {
        let (_vault, data) = dirs();
        seed_snapshot(&data, "n.md", "20200101_000000_000", "ancient");
        let recent = Utc::now().format("%Y%m%d_%H%M%S_%3f").to_string();
        seed_snapshot(&data, "n.md", &recent, "fresh");
        prune(&version_dir(&data, "n.md"));
        let v = list_versions(&data, "n.md").unwrap();
        assert_eq!(v.len(), 1, "the ancient snapshot should be pruned by age");
        assert_eq!(read_version(&data, "n.md", &v[0].id).unwrap(), "fresh");
        std::fs::remove_dir_all(data.parent().unwrap()).ok();
    }

    #[test]
    fn rename_moves_history_with_the_note() {
        let (vault, data) = dirs();
        std::fs::write(vault.join("from.md"), "x").unwrap();
        snapshot_now(&data, &vault, "from.md").unwrap();
        rename(&data, "from.md", "to.md");
        assert!(list_versions(&data, "from.md").unwrap().is_empty());
        assert_eq!(list_versions(&data, "to.md").unwrap().len(), 1);
        std::fs::remove_dir_all(vault.parent().unwrap()).ok();
    }
}
