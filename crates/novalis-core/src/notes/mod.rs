//! Note service layer: combines vault filesystem operations with index upkeep
//! so each Tauri command stays a one-liner. Functions take an explicit
//! `&Connection` and vault/data paths — no shared state, fully testable.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use rusqlite::{params, Connection};

use crate::change;
use crate::error::{CoreError, CoreResult};
use crate::models::{
    CreateNoteRequest, EmbedResolution, EmbedTargetKind, Note, NoteSummary, NoteTemplate,
    PropertyValue, UpdateMetaRequest,
};
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
            let tpl_path =
                vault_fs::vault_rel(&data_dir.join("templates"), &format!("{template_id}.json"))?;
            if tpl_path.exists() {
                let data = std::fs::read_to_string(&tpl_path)?;
                let tpl: NoteTemplate = serde_json::from_str(&data)?;
                // Resolve `{{title}}`/`{{date}}`/`{{time}}` rather than writing
                // them literally. Title comes from the new note's filename stem.
                let title = Path::new(&req.path)
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string());
                crate::templates::render_template(
                    &tpl.content,
                    &crate::templates::TemplateContext { title },
                )
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

/// File-IO phase of [`update`], safe to run OFF the engine lock: snapshot the
/// pre-overwrite content into version history (best-effort), write the new
/// content, and read it back — returning the fresh [`Note`] plus the
/// [`NoteSummary`] the caller feeds to [`crate::index::search::index_note`]
/// under the lock. Does no DB work, so a slow (e.g. cloud-synced) write never
/// holds the lock.
pub fn update_write(
    vault: &Path,
    data_dir: &Path,
    path: &str,
    content: &str,
) -> CoreResult<(Note, NoteSummary)> {
    if let Err(e) = crate::versions::snapshot(data_dir, vault, path) {
        log::warn!("version snapshot failed for {path}: {e}");
    }
    vault_fs::write_note(vault, path, content)?;
    let note = vault_fs::read_note(vault, path)?;
    let summary = vault_fs::build_summary(vault, path)?;
    Ok((note, summary))
}

/// Overwrite a note's content (updating `modified`) and re-index it. Snapshots
/// the pre-overwrite content into version history first (best-effort).
///
/// The file-IO half is factored into [`update_write`] so the desktop command
/// can run it off the engine lock and re-acquire only for the index upsert;
/// this in-process variant keeps the one-call shape for internal callers
/// (`link_mention`, `restore_version`). Indexing from the just-read `note`
/// content + summary is identical to [`change::reindex_path`] (the file exists,
/// so its existence branch never applies) — one fewer disk read.
pub fn update(
    db: &Connection,
    vault: &Path,
    data_dir: &Path,
    path: &str,
    content: &str,
) -> CoreResult<Note> {
    let (note, summary) = update_write(vault, data_dir, path, content)?;
    crate::index::search::index_note_with_opts(
        db,
        &summary,
        &note.content,
        crate::index::search::IndexOptions::for_vault(vault),
    )?;
    // Keep the on-disk mtime stamped so the incremental startup scan can skip
    // this note next time (matches `change::reindex_path`).
    if let Some(ms) = std::fs::metadata(vault_fs::vault_rel(vault, path)?)
        .ok()
        .as_ref()
        .and_then(vault_fs::file_mtime_ms)
    {
        crate::index::search::stamp_mtime(db, path, ms)?;
    }
    Ok(note)
}

/// Restore a note to a stored snapshot. Captures the current content as a new
/// version first, so a restore can itself be undone.
pub fn restore_version(
    db: &Connection,
    vault: &Path,
    data_dir: &Path,
    path: &str,
    version_id: &str,
) -> CoreResult<Note> {
    let content = crate::versions::read_version(data_dir, path, version_id)?;
    let _ = crate::versions::snapshot_now(data_dir, vault, path);
    update(db, vault, data_dir, path, &content)
}

/// Update frontmatter metadata (title/tags/pinned/aliases) without touching the body.
pub fn update_meta(db: &Connection, vault: &Path, req: UpdateMetaRequest) -> CoreResult<Note> {
    let path = req.path.clone().unwrap_or_default();
    let note = vault_fs::read_note(vault, &path)?;
    // STRICT parse: broken frontmatter must error, not fall back to a default
    // we would then serialize over the user's hand-written metadata.
    let (mut fm, body) = frontmatter::parse_frontmatter_strict(&note.content)?;

    if let Some(title) = req.title {
        // Empty title clears it (display falls back to the first H1, then filename).
        let t = title.trim();
        fm.title = if t.is_empty() {
            None
        } else {
            Some(t.to_string())
        };
    }
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
    vault_fs::write_atomic(&vault_fs::vault_rel(vault, &path)?, &new_content)?;

    let updated = vault_fs::read_note(vault, &path)?;
    change::reindex_path(db, vault, &path)?;
    Ok(updated)
}

/// Frontmatter keys owned by the typed schema — the custom-property API must
/// never CREATE them (they have dedicated fields on [`UpdateMetaRequest`]).
/// Checked case-insensitively on the creation surfaces (`set`, rename's `to`):
/// a hand-written `Title:` key is legal YAML but too confusable to mint here.
/// Removal and rename-FROM stay permitted, so a confusable key a user wrote by
/// hand can be fixed through the panel instead of only by editing YAML.
const RESERVED_KEYS: [&str; 6] = ["title", "tags", "aliases", "created", "modified", "pinned"];

/// Validate a custom property key shape: non-empty after trimming.
fn valid_property_key(key: &str) -> CoreResult<String> {
    let key = key.trim();
    if key.is_empty() {
        return Err(CoreError::BadRequest("empty property key".into()));
    }
    Ok(key.to_string())
}

/// Validate a key being CREATED: non-empty and not (a case variant of) a
/// reserved frontmatter field.
fn ensure_property_key(key: &str) -> CoreResult<String> {
    let key = valid_property_key(key)?;
    if RESERVED_KEYS.contains(&key.to_ascii_lowercase().as_str()) {
        return Err(CoreError::BadRequest(format!(
            "'{key}' is a reserved frontmatter field"
        )));
    }
    Ok(key)
}

/// True for strings the on-disk round-trip would destroy: serde_yaml emits
/// them unquoted, but the (yaml-rust2) frontmatter READER resolves them as
/// non-finite floats, which degrade to `null`. Rejected loudly until reader
/// and writer share one YAML dialect (tracked follow-up — hand-written
/// occurrences have the same pre-existing hazard on every body save).
fn is_yaml_hostile_text(s: &str) -> bool {
    let t = s.trim();
    let t = t.strip_prefix(['+', '-']).unwrap_or(t);
    t.eq_ignore_ascii_case("inf")
        || t.eq_ignore_ascii_case("infinity")
        || t.eq_ignore_ascii_case("nan")
}

/// Convert a wire [`PropertyValue`] to the JSON written into `extra`. Numbers
/// are integer-preserved at this write boundary (`count: 42`, never `42.0`) —
/// the wire type is f64 only because specta needs a closed scalar.
fn property_value_to_json(value: PropertyValue) -> CoreResult<serde_json::Value> {
    Ok(match value {
        PropertyValue::Text(s) => {
            if is_yaml_hostile_text(&s) {
                return Err(CoreError::BadRequest(format!(
                    "'{s}' cannot be stored as text (YAML would re-read it as a number)"
                )));
            }
            serde_json::Value::String(s)
        }
        PropertyValue::Checkbox(b) => serde_json::Value::Bool(b),
        PropertyValue::List(items) => {
            if let Some(bad) = items.iter().find(|i| is_yaml_hostile_text(i)) {
                return Err(CoreError::BadRequest(format!(
                    "'{bad}' cannot be stored as text (YAML would re-read it as a number)"
                )));
            }
            serde_json::Value::Array(items.into_iter().map(serde_json::Value::String).collect())
        }
        PropertyValue::Number(n) => {
            // `None` is how a frontend NaN arrives (JSON has no NaN) — reject
            // it structurally rather than failing deserialization.
            let n = n.ok_or_else(|| CoreError::BadRequest("not a number".into()))?;
            if !n.is_finite() {
                return Err(CoreError::BadRequest("non-finite number".into()));
            }
            // Half-open upper bound: `i64::MAX as f64` rounds UP to 2^63,
            // which is NOT representable — it must take the float branch, not
            // saturate to i64::MAX.
            if n.fract() == 0.0 && n >= i64::MIN as f64 && n < i64::MAX as f64 {
                serde_json::Value::from(n as i64)
            } else {
                serde_json::Number::from_f64(n)
                    .map(serde_json::Value::Number)
                    .ok_or_else(|| CoreError::BadRequest("unrepresentable number".into()))?
            }
        }
    })
}

/// Read-parse-mutate-serialize-write a note's custom frontmatter keys (the
/// `extra` passthrough), then reindex — the same shape as [`update_meta`].
/// Only `extra` and `modified` change; known fields and the body pass through
/// untouched. Custom keys re-emit in BTreeMap (alphabetical) order, which is
/// round-trip stable.
fn mutate_extra(
    db: &Connection,
    vault: &Path,
    path: &str,
    f: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> CoreResult<()>,
) -> CoreResult<Note> {
    let note = vault_fs::read_note(vault, path)?;
    // STRICT parse: broken frontmatter must error, not fall back to a default
    // we would then serialize over the user's hand-written metadata.
    let (mut fm, body) = frontmatter::parse_frontmatter_strict(&note.content)?;

    // `extra` is Null on a fresh default; normalize to an object to mutate.
    let mut map = match fm.extra.take() {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };
    f(&mut map)?;
    fm.extra = serde_json::Value::Object(map);
    fm.modified = chrono::Utc::now().to_rfc3339();

    let new_content = frontmatter::serialize_frontmatter(&fm, &body);
    vault_fs::write_atomic(&vault_fs::vault_rel(vault, path)?, &new_content)?;

    let updated = vault_fs::read_note(vault, path)?;
    change::reindex_path(db, vault, path)?;
    Ok(updated)
}

/// Set (create or overwrite) a custom frontmatter property.
pub fn set_property(
    db: &Connection,
    vault: &Path,
    path: &str,
    key: &str,
    value: PropertyValue,
) -> CoreResult<Note> {
    let key = ensure_property_key(key)?;
    let json = property_value_to_json(value)?;
    mutate_extra(db, vault, path, |map| {
        map.insert(key, json);
        Ok(())
    })
}

/// Remove a custom frontmatter property. Erroring (instead of a silent no-op)
/// on a missing key avoids a pointless file write + `modified` churn. Reserved
/// names pass key validation here — the typed fields never live in `extra`, so
/// they yield NotFound, while a hand-written case variant (`Title:`) IS
/// removable.
pub fn remove_property(db: &Connection, vault: &Path, path: &str, key: &str) -> CoreResult<Note> {
    let key = valid_property_key(key)?;
    mutate_extra(db, vault, path, |map| {
        if map.remove(&key).is_none() {
            return Err(CoreError::NotFound(format!("no property '{key}'")));
        }
        Ok(())
    })
}

/// Rename a custom frontmatter property, preserving its value. Errors if
/// `from` is missing or `to` already exists / is reserved. `from` may be a
/// reserved case variant (so a confusable hand-written key can be renamed
/// into a sane one); `to` may not.
pub fn rename_property(
    db: &Connection,
    vault: &Path,
    path: &str,
    from: &str,
    to: &str,
) -> CoreResult<Note> {
    let from = valid_property_key(from)?;
    let to = ensure_property_key(to)?;
    mutate_extra(db, vault, path, |map| {
        if from != to && map.contains_key(&to) {
            return Err(CoreError::AlreadyExists(format!("property '{to}'")));
        }
        let Some(value) = map.remove(&from) else {
            return Err(CoreError::NotFound(format!("no property '{from}'")));
        };
        map.insert(to, value);
        Ok(())
    })
}

/// Move/rename a note and update the index. Version history follows the note.
pub fn move_note(
    db: &Connection,
    vault: &Path,
    data_dir: &Path,
    from: &str,
    to: &str,
) -> CoreResult<Note> {
    vault_fs::move_note(vault, from, to)?;
    crate::versions::rename(data_dir, from, to);
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

/// Trash a note (into the vault's `.novalis/trash`) and remove it from the index.
pub fn delete(db: &Connection, vault: &Path, path: &str) -> CoreResult<()> {
    vault_fs::delete_note(vault, path)?;
    change::remove(db, path)?;
    Ok(())
}

/// Resolve a target title to an existing note's path: exact case-insensitive
/// title match first, then an alias fallback. Returns `None` when nothing
/// matches. Shared by [`resolve_or_create_wiki_link`] (which creates on `None`)
/// and [`resolve_embed`] (which reports `Missing` on `None`) so the two paths
/// never drift.
///
/// The alias `LIKE` is a cheap pre-filter over the JSON-array `aliases` column;
/// the authoritative check is the exact case-insensitive compare, so `[[al]]`
/// doesn't resolve to a note aliased "Allan". Ties resolve to the
/// most-recently-modified note (`ORDER BY modified DESC`).
fn resolve_note_path(db: &Connection, target: &str) -> CoreResult<Option<String>> {
    // 1. Existing note by title (case-insensitive).
    let by_title: Option<String> = db
        .query_row(
            "SELECT path FROM note_meta WHERE lower(title) = lower(?1) ORDER BY modified DESC LIMIT 1",
            params![target],
            |row| row.get(0),
        )
        .ok();
    if by_title.is_some() {
        return Ok(by_title);
    }

    // 2. Existing note by alias (case-insensitive exact match).
    let pattern = format!("%{}%", crate::index::search::escape_like(target));
    let mut stmt = db.prepare(
        "SELECT path, aliases FROM note_meta WHERE aliases LIKE ?1 ESCAPE '\\' ORDER BY modified DESC",
    )?;
    let rows = stmt.query_map(params![pattern], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for (path, aliases_str) in rows.filter_map(|r| crate::index::ok_row_or_warn("note_meta", r)) {
        let aliases: Vec<String> = serde_json::from_str(&aliases_str).unwrap_or_default();
        if aliases
            .iter()
            .any(|a| a.trim().eq_ignore_ascii_case(target))
        {
            return Ok(Some(path));
        }
    }
    Ok(None)
}

/// Resolve a `[[wikilink]]` target title to an existing note's path, or create
/// a new note at the vault root and return its path. Used when the user clicks
/// a wikilink in the editor.
///
/// Resolution order: existing note by title or alias ([`resolve_note_path`]),
/// then create `<sanitized>.md` at vault root. Reserved filesystem characters
/// are stripped.
pub fn resolve_or_create_wiki_link(
    db: &Connection,
    vault: &Path,
    title: &str,
) -> CoreResult<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(CoreError::BadRequest("empty wikilink title".into()));
    }

    // Existing note by title or alias.
    if let Some(path) = resolve_note_path(db, title)? {
        return Ok(path);
    }

    // Miss → create at vault root using a sanitized filename.
    let filename = sanitize_wiki_link_filename(title);
    let path = format!("{filename}.md");
    let note = vault_fs::create_note(vault, &path, "")?;
    change::reindex_path(db, vault, &note.path)?;
    Ok(note.path)
}

/// Slice the body under the ATX heading matching `section` (case-insensitive,
/// trimmed) up to — but excluding — the next heading of the same or a higher
/// level (so deeper sub-headings stay part of the section). The heading line
/// itself is excluded (the embed surfaces it as the title). Headings inside
/// fenced code (```` ``` ````/`~~~`) are ignored, mirroring the task scanner.
/// Returns `None` when the section heading isn't found.
fn slice_section(body: &str, section: &str) -> Option<String> {
    static HEADING_RE: OnceLock<Regex> = OnceLock::new();
    let re = HEADING_RE.get_or_init(|| Regex::new(r"^ {0,3}(#{1,6})\s+(.+)$").unwrap());
    let want = section.trim();
    let lines: Vec<&str> = body.lines().collect();
    let mut in_fence = false;
    let mut start: Option<(usize, usize)> = None; // (first content line, heading level)

    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some(c) = re.captures(line) else { continue };
        let level = c.get(1).unwrap().as_str().len();
        let text = c
            .get(2)
            .unwrap()
            .as_str()
            .trim_end_matches([' ', '#'])
            .trim();
        match start {
            None => {
                if text.eq_ignore_ascii_case(want) {
                    start = Some((i + 1, level));
                }
            }
            // Inside the section: a same-or-higher-level heading ends it.
            Some((s, lvl)) if level <= lvl => {
                return Some(lines[s..i].join("\n").trim_matches('\n').to_string());
            }
            Some(_) => {}
        }
    }

    start.map(|(s, _)| lines[s..].join("\n").trim_matches('\n').to_string())
}

/// Resolve an `![[embed]]` target to a renderable note **without ever creating
/// a file**. Reuses [`resolve_note_path`]'s title-then-alias lookup, but a miss
/// returns [`EmbedTargetKind::Missing`] instead of materializing a note (an
/// embed of a non-existent note must not litter the vault). On a hit, the note
/// is read and its frontmatter stripped so only the body is embedded.
///
/// A `![[Note#Heading]]` anchor resolves `Note` as the title/alias and slices
/// the named section out of the body (see [`slice_section`]). A section that
/// isn't found yields a `Note` hit with an **empty body** (not `Missing`) — the
/// note exists, so the UI can say "section not found" while still naming it.
pub fn resolve_embed(db: &Connection, vault: &Path, target: &str) -> CoreResult<EmbedResolution> {
    let target = target.trim();
    if target.is_empty() {
        return Err(CoreError::BadRequest("empty embed target".into()));
    }

    // Split off an optional `#section` anchor; resolve the note by name only.
    let (name, section) = match target.split_once('#') {
        Some((n, s)) => (n.trim(), Some(s.trim())),
        None => (target, None),
    };

    // Existing note by title or alias — but NEVER create on miss.
    let Some(path) = resolve_note_path(db, name)? else {
        return Ok(EmbedResolution {
            kind: EmbedTargetKind::Missing,
            path: None,
            title: None,
            body: None,
        });
    };

    // Hit → read the note and strip frontmatter; embeds render the body only.
    let note = vault_fs::read_note(vault, &path)?;
    let (_fm, body) = frontmatter::parse_frontmatter(&note.content);
    let body = match section {
        // A section heading that isn't found → empty body (kind stays Note).
        Some(sec) if !sec.is_empty() => slice_section(&body, sec).unwrap_or_default(),
        _ => body,
    };
    Ok(EmbedResolution {
        kind: EmbedTargetKind::Note,
        path: Some(note.path),
        title: Some(note.title),
        body: Some(body),
    })
}

/// Convert the first bare mention of `title` on `line` (1-based, raw-file
/// coordinates as reported by [`crate::index::links::unlinked_mentions`]) in
/// `source_path` into a `[[title]]` wikilink, persisting + reindexing through
/// the normal [`update`] path (so it is versioned). Idempotent when the line is
/// already linked; errors *without writing* if the mention is no longer there,
/// so a stale panel can never corrupt unrelated text.
pub fn link_mention(
    db: &Connection,
    vault: &Path,
    data_dir: &Path,
    source_path: &str,
    title: &str,
    line: usize,
) -> CoreResult<Note> {
    use crate::index::links::{link_bare_mention_in_line, MentionLink};

    let title = title.trim();
    if title.is_empty() {
        return Err(CoreError::BadRequest("empty link title".into()));
    }

    let note = vault_fs::read_note(vault, source_path)?;
    let idx = line
        .checked_sub(1)
        .ok_or_else(|| CoreError::BadRequest("invalid line number".into()))?;
    let mut parts: Vec<String> = note.content.split('\n').map(str::to_string).collect();
    if idx >= parts.len() {
        return Err(CoreError::BadRequest("line out of range".into()));
    }

    // Preserve the line's original line ending when rewriting it.
    let target = parts[idx].clone();
    let had_cr = target.ends_with('\r');
    let core = target.strip_suffix('\r').unwrap_or(&target);

    match link_bare_mention_in_line(core, title) {
        MentionLink::Replaced(replaced) => {
            parts[idx] = if had_cr {
                format!("{replaced}\r")
            } else {
                replaced
            };
            update(db, vault, data_dir, source_path, &parts.join("\n"))
        }
        MentionLink::AlreadyLinked => Ok(note),
        MentionLink::NotFound => Err(CoreError::BadRequest(format!(
            "no unlinked mention of '{title}' on line {line}"
        ))),
    }
}

/// Strip filesystem-reserved characters from a wikilink title so it can be
/// used as a filename on Windows/macOS/Linux. Path separators become dashes
/// (so `[[Foo/Bar]]` does not silently create subfolders).
fn sanitize_wiki_link_filename(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '/' | '\\' => '-',
            ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::{schema, search};

    struct Ctx {
        _tmp: tempfile::TempDir,
        vault: std::path::PathBuf,
        data: std::path::PathBuf,
        db: Connection,
    }

    fn ctx() -> Ctx {
        let base = tempfile::tempdir().unwrap();
        let vault = base.path().join("vault");
        let data = base.path().join("data");
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::create_dir_all(data.join("db")).unwrap();
        let db = schema::open_db(&data.join("db/notes.db")).unwrap();
        Ctx {
            _tmp: base,
            vault,
            data,
            db,
        }
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
        update(
            &c.db,
            &c.vault,
            &c.data,
            "Ideas.md",
            "# Ideas\nthe osprey hunts",
        )
        .unwrap();
        assert!(search::search(&c.db, "peregrine", None, None)
            .unwrap()
            .is_empty());
        assert_eq!(
            search::search(&c.db, "osprey", None, None).unwrap().len(),
            1
        );

        // Delete (trash) removes it from the index.
        delete(&c.db, &c.vault, "Ideas.md").unwrap();
        assert!(search::search(&c.db, "osprey", None, None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn update_snapshots_and_restore_version_round_trips() {
        let c = ctx();
        create(
            &c.db,
            &c.vault,
            &c.data,
            CreateNoteRequest {
                path: "Doc.md".to_string(),
                content: Some("# Doc\nfirst body".to_string()),
                template: None,
            },
        )
        .unwrap();

        // An update snapshots the pre-overwrite content into version history.
        update(&c.db, &c.vault, &c.data, "Doc.md", "# Doc\nsecond body").unwrap();
        let versions = crate::versions::list_versions(&c.data, "Doc.md").unwrap();
        assert_eq!(versions.len(), 1, "the pre-update content was snapshotted");

        // Restoring that version brings back the old body (and snapshots current
        // first, so the restore is itself undoable → 2 versions).
        let restored =
            restore_version(&c.db, &c.vault, &c.data, "Doc.md", &versions[0].id).unwrap();
        assert!(restored.content.contains("first body"));
        assert!(!restored.content.contains("second body"));
        assert_eq!(
            crate::versions::list_versions(&c.data, "Doc.md")
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn update_meta_renames_title_without_moving_the_file() {
        let c = ctx();
        create(
            &c.db,
            &c.vault,
            &c.data,
            CreateNoteRequest {
                path: "Note.md".to_string(),
                content: None,
                template: None,
            },
        )
        .unwrap();

        // Sidebar "Rename" sets the frontmatter title; the file path is stable.
        let updated = update_meta(
            &c.db,
            &c.vault,
            UpdateMetaRequest {
                path: Some("Note.md".to_string()),
                title: Some("Renamed".to_string()),
                tags: None,
                pinned: None,
                aliases: None,
            },
        )
        .unwrap();

        assert_eq!(updated.path, "Note.md");
        assert_eq!(updated.title, "Renamed");
        assert!(c.vault.join("Note.md").exists());
        // The summary the sidebar renders reflects the new title.
        assert_eq!(
            vault_fs::build_summary(&c.vault, "Note.md").unwrap().title,
            "Renamed"
        );
    }

    #[test]
    fn update_meta_fails_loud_on_malformed_frontmatter() {
        let c = ctx();
        // Deserialization fails (`pinned` is not a boolean — an uncoercible
        // type, unlike the integer/scalar cases the parser now tolerates); with
        // a lenient parse the default would be re-serialized over the
        // hand-written metadata. The update must error and leave the file untouched.
        let broken = "---\ntitle: Keep\npinned: notabool\n---\nbody";
        std::fs::write(c.vault.join("B.md"), broken).unwrap();
        crate::change::reindex_path(&c.db, &c.vault, "B.md").unwrap();

        let res = update_meta(
            &c.db,
            &c.vault,
            UpdateMetaRequest {
                path: Some("B.md".to_string()),
                title: Some("New".to_string()),
                tags: None,
                pinned: None,
                aliases: None,
            },
        );
        assert!(res.is_err());
        assert_eq!(
            std::fs::read_to_string(c.vault.join("B.md")).unwrap(),
            broken
        );

        std::fs::remove_dir_all(c.vault.parent().unwrap()).ok();
    }

    /// The typed value of `key` as surfaced on a fresh read of the note.
    fn prop_of(c: &Ctx, path: &str, key: &str) -> Option<PropertyValue> {
        vault_fs::read_note(&c.vault, path)
            .unwrap()
            .properties
            .into_iter()
            .find(|p| p.key == key)
            .map(|p| p.value)
    }

    #[test]
    fn set_property_writes_each_variant_and_reads_back_typed() {
        let c = ctx();
        create(
            &c.db,
            &c.vault,
            &c.data,
            CreateNoteRequest {
                path: "P.md".into(),
                content: Some("# P\nbody stays".into()),
                template: None,
            },
        )
        .unwrap();

        set_property(
            &c.db,
            &c.vault,
            "P.md",
            "status",
            PropertyValue::Text("draft".into()),
        )
        .unwrap();
        set_property(
            &c.db,
            &c.vault,
            "P.md",
            "rating",
            PropertyValue::Number(Some(2.5)),
        )
        .unwrap();
        set_property(
            &c.db,
            &c.vault,
            "P.md",
            "done",
            PropertyValue::Checkbox(true),
        )
        .unwrap();
        set_property(
            &c.db,
            &c.vault,
            "P.md",
            "people",
            PropertyValue::List(vec!["ada".into(), "alan".into()]),
        )
        .unwrap();

        assert_eq!(
            prop_of(&c, "P.md", "status"),
            Some(PropertyValue::Text("draft".into()))
        );
        assert_eq!(
            prop_of(&c, "P.md", "rating"),
            Some(PropertyValue::Number(Some(2.5)))
        );
        assert_eq!(
            prop_of(&c, "P.md", "done"),
            Some(PropertyValue::Checkbox(true))
        );
        assert_eq!(
            prop_of(&c, "P.md", "people"),
            Some(PropertyValue::List(vec!["ada".into(), "alan".into()]))
        );

        // The body and known frontmatter fields are untouched.
        let note = vault_fs::read_note(&c.vault, "P.md").unwrap();
        assert!(note.content.contains("body stays"));
        assert!(note.content.contains("# P"));
        // Overwrite replaces the value without duplicating the YAML key —
        // asserted on the raw file AFTER the overwrite.
        set_property(
            &c.db,
            &c.vault,
            "P.md",
            "status",
            PropertyValue::Text("final".into()),
        )
        .unwrap();
        assert_eq!(
            prop_of(&c, "P.md", "status"),
            Some(PropertyValue::Text("final".into()))
        );
        let raw = std::fs::read_to_string(c.vault.join("P.md")).unwrap();
        assert_eq!(raw.matches("status:").count(), 1);
        assert!(raw.contains("status: final"));
    }

    #[test]
    fn set_property_preserves_integers_on_disk() {
        let c = ctx();
        create(
            &c.db,
            &c.vault,
            &c.data,
            CreateNoteRequest {
                path: "N.md".into(),
                content: None,
                template: None,
            },
        )
        .unwrap();

        // A whole-valued Number lands as a YAML integer, not 42.0 — and a
        // second round-trip (read → re-set) keeps it an integer.
        set_property(
            &c.db,
            &c.vault,
            "N.md",
            "count",
            PropertyValue::Number(Some(42.0)),
        )
        .unwrap();
        let raw = std::fs::read_to_string(c.vault.join("N.md")).unwrap();
        assert!(
            raw.contains("count: 42\n"),
            "expected integer in YAML, got:\n{raw}"
        );
        assert!(!raw.contains("42.0"));
        let read_back = prop_of(&c, "N.md", "count").unwrap();
        set_property(&c.db, &c.vault, "N.md", "count", read_back).unwrap();
        let raw2 = std::fs::read_to_string(c.vault.join("N.md")).unwrap();
        assert!(raw2.contains("count: 42\n"));

        // Real fractions keep their fraction; non-finite is rejected.
        set_property(
            &c.db,
            &c.vault,
            "N.md",
            "ratio",
            PropertyValue::Number(Some(2.5)),
        )
        .unwrap();
        assert!(std::fs::read_to_string(c.vault.join("N.md"))
            .unwrap()
            .contains("ratio: 2.5"));
        assert!(set_property(
            &c.db,
            &c.vault,
            "N.md",
            "bad",
            PropertyValue::Number(Some(f64::NAN))
        )
        .is_err());
        // A frontend NaN arrives over IPC as null → Number(None): structured reject.
        assert!(set_property(&c.db, &c.vault, "N.md", "bad", PropertyValue::Number(None)).is_err());
        // The 2^63 boundary must NOT saturate to i64::MAX (it takes the float branch).
        set_property(
            &c.db,
            &c.vault,
            "N.md",
            "big",
            PropertyValue::Number(Some(9223372036854775808.0)),
        )
        .unwrap();
        let raw3 = std::fs::read_to_string(c.vault.join("N.md")).unwrap();
        assert!(
            !raw3.contains("9223372036854775807"),
            "must not saturate:\n{raw3}"
        );
    }

    #[test]
    fn property_api_rejects_reserved_and_empty_keys() {
        let c = ctx();
        create(
            &c.db,
            &c.vault,
            &c.data,
            CreateNoteRequest {
                path: "R.md".into(),
                content: None,
                template: None,
            },
        )
        .unwrap();
        set_property(
            &c.db,
            &c.vault,
            "R.md",
            "ok",
            PropertyValue::Text("x".into()),
        )
        .unwrap();

        for key in [
            "title", "tags", "aliases", "created", "modified", "pinned", "Title", "PINNED",
        ] {
            assert!(
                set_property(
                    &c.db,
                    &c.vault,
                    "R.md",
                    key,
                    PropertyValue::Text("x".into())
                )
                .is_err(),
                "set_property must reject reserved key {key}"
            );
            assert!(
                rename_property(&c.db, &c.vault, "R.md", "ok", key).is_err(),
                "rename_property must reject reserved target {key}"
            );
            // remove allows the NAME (so hand-written case variants are fixable)
            // but the typed fields never live in `extra` → NotFound, no write.
            assert!(
                remove_property(&c.db, &c.vault, "R.md", key).is_err(),
                "remove_property must error for absent key {key}"
            );
        }
        assert!(set_property(
            &c.db,
            &c.vault,
            "R.md",
            "  ",
            PropertyValue::Text("x".into())
        )
        .is_err());
        // None of the rejected calls wrote anything.
        assert_eq!(
            prop_of(&c, "R.md", "ok"),
            Some(PropertyValue::Text("x".into()))
        );
        assert!(!std::fs::read_to_string(c.vault.join("R.md"))
            .unwrap()
            .contains("Title"));

        // A hand-written case VARIANT of a reserved key is not consumed by the
        // typed fields (serde is case-sensitive): it surfaces as a property and
        // is removable/renamable through the API — only CREATING one is blocked.
        std::fs::write(
            c.vault.join("R2.md"),
            "---\ntitle: R2\nTitle: confusable\n---\n\nbody",
        )
        .unwrap();
        crate::change::reindex_path(&c.db, &c.vault, "R2.md").unwrap();
        assert_eq!(
            prop_of(&c, "R2.md", "Title"),
            Some(PropertyValue::Text("confusable".into()))
        );
        remove_property(&c.db, &c.vault, "R2.md", "Title").unwrap();
        assert_eq!(prop_of(&c, "R2.md", "Title"), None);
    }

    #[test]
    fn remove_and_rename_property_semantics() {
        let c = ctx();
        create(
            &c.db,
            &c.vault,
            &c.data,
            CreateNoteRequest {
                path: "M.md".into(),
                content: None,
                template: None,
            },
        )
        .unwrap();
        set_property(
            &c.db,
            &c.vault,
            "M.md",
            "status",
            PropertyValue::Text("draft".into()),
        )
        .unwrap();
        set_property(
            &c.db,
            &c.vault,
            "M.md",
            "other",
            PropertyValue::Number(Some(1.0)),
        )
        .unwrap();

        // Rename preserves the value; the old key is gone.
        rename_property(&c.db, &c.vault, "M.md", "status", "state").unwrap();
        assert_eq!(
            prop_of(&c, "M.md", "state"),
            Some(PropertyValue::Text("draft".into()))
        );
        assert_eq!(prop_of(&c, "M.md", "status"), None);
        // Renaming onto an existing key or from a missing key errors.
        assert!(rename_property(&c.db, &c.vault, "M.md", "state", "other").is_err());
        assert!(rename_property(&c.db, &c.vault, "M.md", "ghost", "x").is_err());

        // Remove deletes; removing a missing key errors (no silent write).
        remove_property(&c.db, &c.vault, "M.md", "state").unwrap();
        assert_eq!(prop_of(&c, "M.md", "state"), None);
        assert!(remove_property(&c.db, &c.vault, "M.md", "state").is_err());
    }

    #[test]
    fn properties_reemit_alphabetically_and_stay_stable() {
        let c = ctx();
        // Hand-ordered legacy note: z_key listed before a_key.
        std::fs::write(
            c.vault.join("L.md"),
            "---\ntitle: L\nz_key: zed\na_key: aye\n---\n\nbody",
        )
        .unwrap();
        crate::change::reindex_path(&c.db, &c.vault, "L.md").unwrap();

        // First property write re-emits custom keys alphabetically (the
        // documented one-time reorder for hand-ordered notes)...
        set_property(
            &c.db,
            &c.vault,
            "L.md",
            "m_key",
            PropertyValue::Text("em".into()),
        )
        .unwrap();
        let raw1 = std::fs::read_to_string(c.vault.join("L.md")).unwrap();
        let (a, m, z) = (
            raw1.find("a_key:").unwrap(),
            raw1.find("m_key:").unwrap(),
            raw1.find("z_key:").unwrap(),
        );
        assert!(
            a < m && m < z,
            "custom keys must re-emit alphabetically:\n{raw1}"
        );
        assert!(raw1.contains("zed") && raw1.contains("aye"));

        // ...and a second pass is byte-stable for the frontmatter block apart
        // from `modified` (no ordering churn).
        set_property(
            &c.db,
            &c.vault,
            "L.md",
            "m_key",
            PropertyValue::Text("em".into()),
        )
        .unwrap();
        let raw2 = std::fs::read_to_string(c.vault.join("L.md")).unwrap();
        let strip_modified = |s: &str| -> String {
            s.lines()
                .filter(|l| !l.starts_with("modified:"))
                .collect::<Vec<_>>()
                .join("\n")
        };
        assert_eq!(strip_modified(&raw1), strip_modified(&raw2));
    }

    #[test]
    fn unrelated_set_preserves_nested_values_verbatim() {
        let c = ctx();
        // A hand-written nested map — beyond the panel's editable kinds.
        std::fs::write(
            c.vault.join("X.md"),
            "---\ntitle: X\nmeta:\n  deep: true\n  count: 3\n---\n\nbody",
        )
        .unwrap();
        crate::change::reindex_path(&c.db, &c.vault, "X.md").unwrap();

        set_property(
            &c.db,
            &c.vault,
            "X.md",
            "status",
            PropertyValue::Text("ok".into()),
        )
        .unwrap();

        // The nested map survives semantically (it re-reads to the same JSON)…
        let note = vault_fs::read_note(&c.vault, "X.md").unwrap();
        assert_eq!(
            note.frontmatter.extra.get("meta"),
            Some(&serde_json::json!({"deep": true, "count": 3}))
        );
        // …and surfaces read-only as Text of its JSON.
        assert_eq!(
            prop_of(&c, "X.md", "meta"),
            Some(PropertyValue::Text("{\"count\":3,\"deep\":true}".into()))
        );
    }

    #[test]
    fn resolve_or_create_wiki_link_finds_existing_and_creates_missing() {
        let c = ctx();

        // Seed an existing note titled "Recipes".
        create(
            &c.db,
            &c.vault,
            &c.data,
            CreateNoteRequest {
                path: "Recipes.md".to_string(),
                content: None,
                template: None,
            },
        )
        .unwrap();

        // Case-insensitive resolution finds it.
        let resolved = resolve_or_create_wiki_link(&c.db, &c.vault, "recipes").unwrap();
        assert_eq!(resolved, "Recipes.md");

        // Missing target gets created at vault root.
        let created = resolve_or_create_wiki_link(&c.db, &c.vault, "Birding Trips").unwrap();
        assert_eq!(created, "Birding Trips.md");
        assert!(c.vault.join("Birding Trips.md").exists());

        // Reserved chars are sanitized, not allowed to drill into subfolders.
        let safe = resolve_or_create_wiki_link(&c.db, &c.vault, "Logs/2026").unwrap();
        assert_eq!(safe, "Logs-2026.md");
        assert!(c.vault.join("Logs-2026.md").exists());

        // Empty title errors.
        assert!(resolve_or_create_wiki_link(&c.db, &c.vault, "   ").is_err());
    }

    #[test]
    fn resolve_or_create_wiki_link_resolves_aliases() {
        let c = ctx();

        // A note whose frontmatter declares an alias.
        std::fs::write(
            c.vault.join("Recipes.md"),
            "---\ntitle: Recipes\naliases:\n  - Cookbook\n---\n\nbody",
        )
        .unwrap();
        crate::change::reindex_path(&c.db, &c.vault, "Recipes.md").unwrap();

        // `[[Cookbook]]` resolves to the canonical note (case-insensitive),
        // creating no new file.
        let resolved = resolve_or_create_wiki_link(&c.db, &c.vault, "cookbook").unwrap();
        assert_eq!(resolved, "Recipes.md");
        assert!(!c.vault.join("cookbook.md").exists());

        // Exact match only: `[[al]]` must NOT resolve to a note aliased "Allan"
        // (the LIKE is just a pre-filter) — it creates `al.md`.
        std::fs::write(
            c.vault.join("Person.md"),
            "---\ntitle: Person\naliases:\n  - Allan\n---\n\nbody",
        )
        .unwrap();
        crate::change::reindex_path(&c.db, &c.vault, "Person.md").unwrap();
        let al = resolve_or_create_wiki_link(&c.db, &c.vault, "al").unwrap();
        assert_eq!(al, "al.md");
        assert!(c.vault.join("al.md").exists());
    }

    #[test]
    fn resolve_wiki_link_alias_with_like_metacharacters() {
        let c = ctx();
        std::fs::write(
            c.vault.join("Sale.md"),
            "---\ntitle: Sale\naliases:\n  - \"100% off\"\n---\n\nbody",
        )
        .unwrap();
        crate::change::reindex_path(&c.db, &c.vault, "Sale.md").unwrap();

        // The `%` in the alias must bind literally: the old escaping (`\%`
        // without an ESCAPE clause) missed the row and CREATED a new note.
        let resolved = resolve_or_create_wiki_link(&c.db, &c.vault, "100% off").unwrap();
        assert_eq!(resolved, "Sale.md");
        assert!(!c.vault.join("100% off.md").exists());

        std::fs::remove_dir_all(c.vault.parent().unwrap()).ok();
    }

    #[test]
    fn resolve_embed_finds_note_and_strips_frontmatter() {
        let c = ctx();

        std::fs::write(
            c.vault.join("Recipes.md"),
            "---\ntitle: Recipes\naliases:\n  - Cookbook\n---\n\nThe body of the note.",
        )
        .unwrap();
        crate::change::reindex_path(&c.db, &c.vault, "Recipes.md").unwrap();

        // Resolves by title, case-insensitively.
        let r = resolve_embed(&c.db, &c.vault, "recipes").unwrap();
        assert!(matches!(r.kind, EmbedTargetKind::Note));
        assert_eq!(r.path.as_deref(), Some("Recipes.md"));
        assert_eq!(r.title.as_deref(), Some("Recipes"));

        // The embedded body excludes the YAML frontmatter.
        let body = r.body.unwrap();
        assert!(body.contains("The body of the note."));
        assert!(!body.contains("title: Recipes"));
        assert!(!body.contains("---"));
    }

    #[test]
    fn resolve_embed_resolves_aliases_but_not_partial() {
        let c = ctx();

        std::fs::write(
            c.vault.join("Recipes.md"),
            "---\ntitle: Recipes\naliases:\n  - Cookbook\n---\n\nbody",
        )
        .unwrap();
        crate::change::reindex_path(&c.db, &c.vault, "Recipes.md").unwrap();

        // `![[Cookbook]]` resolves to the canonical note (case-insensitive).
        let hit = resolve_embed(&c.db, &c.vault, "cookbook").unwrap();
        assert!(matches!(hit.kind, EmbedTargetKind::Note));
        assert_eq!(hit.path.as_deref(), Some("Recipes.md"));

        // Exact-match only: a partial of an alias must NOT resolve (LIKE is just
        // a pre-filter) — and must NOT create a file.
        let partial = resolve_embed(&c.db, &c.vault, "Cook").unwrap();
        assert!(matches!(partial.kind, EmbedTargetKind::Missing));
        assert!(!c.vault.join("Cook.md").exists());
    }

    #[test]
    fn resolve_embed_missing_creates_no_file() {
        let c = ctx();

        let r = resolve_embed(&c.db, &c.vault, "Nonexistent Note").unwrap();
        assert!(matches!(r.kind, EmbedTargetKind::Missing));
        assert!(r.path.is_none());
        assert!(r.title.is_none());
        assert!(r.body.is_none());
        // Critically: a missed embed must NOT materialize a note (unlike a
        // `[[wikilink]]` click) — this is the load-bearing invariant.
        assert!(!c.vault.join("Nonexistent Note.md").exists());

        // An empty target is a bad request, not a silent miss.
        assert!(resolve_embed(&c.db, &c.vault, "   ").is_err());
    }

    #[test]
    fn resolve_embed_returns_body_for_note_without_frontmatter() {
        let c = ctx();

        // A plain note with no YAML frontmatter block at all (the common case
        // for legacy/imported notes) — there is nothing to strip.
        let content = "Plain body text.\nNo frontmatter here.\n";
        std::fs::write(c.vault.join("Plain.md"), content).unwrap();
        crate::change::reindex_path(&c.db, &c.vault, "Plain.md").unwrap();

        let r = resolve_embed(&c.db, &c.vault, "Plain").unwrap();
        assert!(matches!(r.kind, EmbedTargetKind::Note));
        // The whole content is the body, returned verbatim (no mangling, no
        // stray `---` delimiters).
        let body = r.body.unwrap();
        assert!(body.contains("Plain body text."));
        assert!(body.contains("No frontmatter here."));
        assert!(!body.starts_with("---"));
    }

    #[test]
    fn resolve_embed_slices_section_anchor() {
        let c = ctx();

        let content =
            "# Daily\n\nintro\n\n## Tasks\n\n- one\n- two\n\n### Sub\n\ndeep\n\n## Done\n\nfini\n";
        std::fs::write(c.vault.join("Daily.md"), content).unwrap();
        crate::change::reindex_path(&c.db, &c.vault, "Daily.md").unwrap();

        // The base note (no anchor) resolves to the whole body.
        let whole = resolve_embed(&c.db, &c.vault, "Daily").unwrap();
        assert!(matches!(whole.kind, EmbedTargetKind::Note));
        assert!(whole.body.as_deref().unwrap().contains("fini"));

        // `Daily#Tasks` slices that section: content up to the next same-or-
        // higher heading (`## Done`), INCLUDING the deeper `### Sub`, but NOT the
        // `## Tasks` heading line itself and NOT the `## Done` section.
        let sec = resolve_embed(&c.db, &c.vault, "Daily#Tasks").unwrap();
        assert!(matches!(sec.kind, EmbedTargetKind::Note));
        let body = sec.body.as_deref().unwrap();
        assert!(body.contains("- one") && body.contains("- two"));
        assert!(body.contains("### Sub") && body.contains("deep")); // deeper nested included
        assert!(!body.contains("## Tasks")); // heading line excluded
        assert!(!body.contains("fini")); // stops before `## Done`
        assert!(!body.contains("intro")); // doesn't bleed from above

        // Case-insensitive heading match.
        assert_eq!(
            resolve_embed(&c.db, &c.vault, "Daily#tasks")
                .unwrap()
                .body
                .as_deref(),
            Some(body),
        );
    }

    #[test]
    fn resolve_embed_missing_section_is_note_with_empty_body() {
        let c = ctx();

        std::fs::write(c.vault.join("Daily.md"), "# Daily\n\n## Tasks\n\n- one\n").unwrap();
        crate::change::reindex_path(&c.db, &c.vault, "Daily.md").unwrap();

        // Note exists but the section doesn't → Note hit with an EMPTY body (so
        // the UI can say "section not found" while still naming the note). The
        // note is NOT created or duplicated.
        let r = resolve_embed(&c.db, &c.vault, "Daily#Nonexistent").unwrap();
        assert!(matches!(r.kind, EmbedTargetKind::Note));
        assert_eq!(r.path.as_deref(), Some("Daily.md"));
        assert_eq!(r.body.as_deref(), Some(""));
        assert!(!c.vault.join("Daily#Nonexistent.md").exists());

        // A `#section` on a NON-existent note is still Missing (no note at all).
        assert!(matches!(
            resolve_embed(&c.db, &c.vault, "Ghost#Tasks").unwrap().kind,
            EmbedTargetKind::Missing
        ));
    }

    #[test]
    fn slice_section_ignores_headings_inside_code_fences() {
        // A `#`-comment inside a fenced block must not be treated as a heading
        // boundary; the fenced block is part of the `Setup` section.
        let body = "## Setup\n\n```sh\n# not a heading\n```\n\nrun it\n\n## Next\n\nafter\n";
        let sliced = slice_section(body, "Setup").unwrap();
        assert!(sliced.contains("# not a heading")); // fenced `#` preserved, not a boundary
        assert!(sliced.contains("run it"));
        assert!(!sliced.contains("after")); // stops at the real `## Next`
        assert!(slice_section(body, "Missing").is_none());
    }
}
