//! Tauri command surface. Each command is a thin wrapper: lock the engine and
//! call a `novalis_core` function. The vault/index lifecycle lives in
//! [`open_vault`] / [`close_vault`].

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager, State};

use novalis_core::change;
use novalis_core::conflict;
use novalis_core::index::{links, schema, search};
use novalis_core::models::{
    AgendaItem, CalendarEvent, CalendarSourceConfig, CaptureRequest, ConflictDiff, ConflictFile,
    CreateNoteRequest, CreateTaskRequest, EmbedResolution, EventInput, FolderNode, LinkReference,
    Note, NoteGraph, NoteSummary, NoteTemplate, PluginInfo, Preferences, PropertyValue,
    ResolveConflictRequest, SearchResult, TagCount, Task, TaskQuery, UpdateMetaRequest, VaultInfo,
    VaultStats,
};
use novalis_core::tasks::service as task_svc;
use novalis_core::trash::{self, TrashItem};
use novalis_core::vault::{config, frontmatter, fs as vault_fs, stats};
use novalis_core::versions::{DiffLine, VersionMeta};
use novalis_core::{calendar, export, media, templates, AppInfo, CoreError};

use crate::engine::{AppEngine, CommandError, Engine};

type CmdResult<T> = Result<T, CommandError>;

/// Returns app/build info from the core. Works without a vault open.
#[tauri::command]
#[specta::specta]
pub fn app_info() -> AppInfo {
    novalis_core::app_info()
}

// ── Vault lifecycle ─────────────────────────────────────────────────────────

/// Open (or create) a vault at `path`: build its index, persist it as the
/// last vault, and start the file watcher. Shared by the command and startup.
pub fn open_vault_impl(app: &AppHandle, path: &str) -> CmdResult<VaultInfo> {
    let state = app.state::<AppEngine>();
    let vault_path = PathBuf::from(path);
    config::ensure_vault_dir(&vault_path).map_err(CoreError::Io)?;

    // Let the webview load images from the vault via the asset protocol.
    let _ = app
        .asset_protocol_scope()
        .allow_directory(&vault_path, true);

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::internal(format!("cannot resolve app data dir: {e}")))?
        .join("vaults")
        .join(vault_key(&vault_path));
    config::ensure_data_dirs(&data_dir).map_err(CoreError::Io)?;
    // Best-effort: relocate any pre-existing app-local trash into the vault so it
    // syncs and survives reinstall (one-time, no-op once migrated).
    if let Err(e) = trash::migrate_legacy_trash(&vault_path, &data_dir) {
        log::warn!("legacy trash migration failed: {e}");
    }

    let db = schema::open_db(&config::db_path(&data_dir))?;
    search::build_index(&db, &vault_path)?;

    let info = stats::vault_info(&vault_path);

    *state
        .0
        .lock()
        .map_err(|_| CommandError::internal("engine lock poisoned"))? = Some(Engine {
        db,
        vault_path: vault_path.clone(),
        data_dir,
    });

    crate::settings::save_last_vault(app, path);
    crate::settings::push_recent_vault(app, path, now_ms());

    // Desktop watches the vault for external changes. Mobile relies on
    // `rescan_vault` (foreground / pull-to-refresh) instead — `notify` isn't
    // built for mobile targets.
    #[cfg(desktop)]
    {
        let generation =
            crate::watcher::WATCH_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        crate::watcher::start(app.clone(), vault_path.clone(), generation);
    }

    let _ = app.emit("reindexed-event", ());
    Ok(info)
}

/// Open (or create) a vault at `path`.
///
/// `async` + `spawn_blocking`: indexing reads every note, and a vault on a
/// cloud-synced folder (OneDrive/iCloud) hydrates online-only files over the
/// network — slow and blocking. A synchronous command runs on the main thread,
/// so that work would freeze the UI; running it on a blocking-pool thread keeps
/// the window responsive (it shows the loading state) while indexing proceeds.
#[tauri::command]
#[specta::specta]
pub async fn open_vault(app: AppHandle, path: String) -> CmdResult<VaultInfo> {
    tauri::async_runtime::spawn_blocking(move || open_vault_impl(&app, &path))
        .await
        .map_err(|e| CommandError::internal(format!("open_vault task panicked: {e}")))?
}

/// Show a native folder picker; returns the chosen path, if any.
///
/// Must be `async`: a synchronous command runs on the main thread, and
/// `blocking_pick_folder` would then deadlock — it asks the main thread's event
/// loop to show the native panel while blocking that same thread. Running the
/// blocking call on a blocking-pool thread keeps the main thread free to render
/// the panel.
#[tauri::command]
#[specta::specta]
pub async fn pick_vault_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|fp| fp.into_path().ok())
            .map(|p| p.to_string_lossy().to_string())
    })
    .await
    .ok()
    .flatten()
}

/// Close the current vault (drops the index connection).
#[tauri::command]
#[specta::specta]
pub fn close_vault(state: State<AppEngine>) -> CmdResult<()> {
    *state
        .0
        .lock()
        .map_err(|_| CommandError::internal("engine lock poisoned"))? = None;
    Ok(())
}

/// Path of the currently open vault, if any.
#[tauri::command]
#[specta::specta]
pub fn current_vault(state: State<AppEngine>) -> CmdResult<Option<String>> {
    let guard = state
        .0
        .lock()
        .map_err(|_| CommandError::internal("engine lock poisoned"))?;
    Ok(guard
        .as_ref()
        .map(|e| e.vault_path.to_string_lossy().to_string()))
}

/// Validate a candidate vault path *without* opening it or touching the engine
/// lock. Returns summary info for an existing directory; errors if the path is
/// missing or not a directory. Used to preview recent vaults and detect ones
/// whose folder was moved/deleted before the user switches to them.
#[tauri::command]
#[specta::specta]
pub fn validate_vault(path: String) -> CmdResult<VaultInfo> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(CoreError::NotFound(format!("vault folder not found: {path}")).into());
    }
    if !p.is_dir() {
        return Err(CoreError::BadRequest(format!("not a folder: {path}")).into());
    }
    Ok(stats::vault_info(&p))
}

/// The recent-vaults list (most-recent first) for quick switching.
#[tauri::command]
#[specta::specta]
pub fn list_recent_vaults(app: AppHandle) -> CmdResult<Vec<crate::settings::RecentVault>> {
    Ok(crate::settings::list_recent_vaults(&app))
}

/// Drop a stale entry (moved/deleted folder) from the recent-vaults list.
#[tauri::command]
#[specta::specta]
pub fn remove_recent_vault(app: AppHandle, path: String) -> CmdResult<()> {
    crate::settings::remove_recent_vault(&app, &path);
    Ok(())
}

// ── Notes ───────────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn list_notes(state: State<AppEngine>) -> CmdResult<Vec<NoteSummary>> {
    state.with(|e| Ok(novalis_core::notes::list(&e.vault_path)))
}

/// `async` + `spawn_blocking`: reading a note on a OneDrive/iCloud vault may
/// hydrate an online-only file over the network. Off the main thread, that read
/// never blocks the UI or other commands (the frontend masks it with a loading
/// state and prefetch-on-hover).
#[tauri::command]
#[specta::specta]
pub async fn get_note(app: AppHandle, path: String) -> CmdResult<Note> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppEngine>()
            .with(|e| novalis_core::notes::get(&e.vault_path, &path))
    })
    .await
    .map_err(|e| CommandError::internal(format!("get_note task panicked: {e}")))?
}

/// `async` + `spawn_blocking`: resolving an `![[embed]]` reads the target note
/// from disk, which on a OneDrive/iCloud vault may hydrate an online-only file
/// over the network — so it runs off the main thread like [`get_note`]. Never
/// creates a note on a miss; returns `EmbedResolution { kind: missing }`.
#[tauri::command]
#[specta::specta]
pub async fn resolve_embed(app: AppHandle, target: String) -> CmdResult<EmbedResolution> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppEngine>()
            .with(|e| novalis_core::notes::resolve_embed(&e.db, &e.vault_path, &target))
    })
    .await
    .map_err(|e| CommandError::internal(format!("resolve_embed task panicked: {e}")))?
}

#[tauri::command]
#[specta::specta]
pub fn create_note(state: State<AppEngine>, req: CreateNoteRequest) -> CmdResult<Note> {
    state.with(|e| novalis_core::notes::create(&e.db, &e.vault_path, &e.data_dir, req))
}

#[tauri::command]
#[specta::specta]
pub fn update_note(state: State<AppEngine>, path: String, content: String) -> CmdResult<Note> {
    state.with(|e| novalis_core::notes::update(&e.db, &e.vault_path, &e.data_dir, &path, &content))
}

#[tauri::command]
#[specta::specta]
pub fn update_note_meta(state: State<AppEngine>, req: UpdateMetaRequest) -> CmdResult<Note> {
    state.with(|e| novalis_core::notes::update_meta(&e.db, &e.vault_path, req))
}

#[tauri::command]
#[specta::specta]
pub fn set_property(
    state: State<AppEngine>,
    path: String,
    key: String,
    value: PropertyValue,
) -> CmdResult<Note> {
    state.with(|e| novalis_core::notes::set_property(&e.db, &e.vault_path, &path, &key, value))
}

#[tauri::command]
#[specta::specta]
pub fn remove_property(state: State<AppEngine>, path: String, key: String) -> CmdResult<Note> {
    state.with(|e| novalis_core::notes::remove_property(&e.db, &e.vault_path, &path, &key))
}

#[tauri::command]
#[specta::specta]
pub fn rename_property(
    state: State<AppEngine>,
    path: String,
    from: String,
    to: String,
) -> CmdResult<Note> {
    state.with(|e| novalis_core::notes::rename_property(&e.db, &e.vault_path, &path, &from, &to))
}

#[tauri::command]
#[specta::specta]
pub fn move_note(state: State<AppEngine>, path: String, new_path: String) -> CmdResult<Note> {
    state.with(|e| {
        novalis_core::notes::move_note(&e.db, &e.vault_path, &e.data_dir, &path, &new_path)
    })
}

#[tauri::command]
#[specta::specta]
pub fn duplicate_note(state: State<AppEngine>, path: String) -> CmdResult<Note> {
    state.with(|e| novalis_core::notes::duplicate(&e.db, &e.vault_path, &path))
}

#[tauri::command]
#[specta::specta]
pub fn delete_note(state: State<AppEngine>, path: String) -> CmdResult<()> {
    state.with(|e| novalis_core::notes::delete(&e.db, &e.vault_path, &path))
}

#[tauri::command]
#[specta::specta]
pub fn resolve_or_create_wiki_link(state: State<AppEngine>, title: String) -> CmdResult<String> {
    state.with(|e| novalis_core::notes::resolve_or_create_wiki_link(&e.db, &e.vault_path, &title))
}

// ── Folders ────────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn get_folder_tree(state: State<AppEngine>) -> CmdResult<FolderNode> {
    state.with(|e| {
        // Pull summaries from the index (no disk reads) and build the tree from
        // the directory structure alone — fast even on a cloud-synced vault.
        let summaries = novalis_core::index::list_summaries(&e.db)?;
        let map: std::collections::HashMap<String, _> =
            summaries.into_iter().map(|s| (s.path.clone(), s)).collect();
        Ok(vault_fs::list_folders(&e.vault_path, &map))
    })
}

#[tauri::command]
#[specta::specta]
pub fn create_folder(state: State<AppEngine>, path: String) -> CmdResult<()> {
    state.with(|e| vault_fs::create_folder(&e.vault_path, &path))
}

#[tauri::command]
#[specta::specta]
pub fn delete_folder(state: State<AppEngine>, path: String) -> CmdResult<()> {
    state.with(|e| vault_fs::delete_folder(&e.vault_path, &path))
}

#[tauri::command]
#[specta::specta]
pub fn move_folder(state: State<AppEngine>, path: String, new_path: String) -> CmdResult<()> {
    // Notes move with the folder; rebuild the index so paths stay correct even
    // before the file watcher catches up.
    state.with(|e| {
        vault_fs::move_folder(&e.vault_path, &path, &new_path)?;
        search::build_index(&e.db, &e.vault_path)
    })
}

/// Delete a folder and all its contents by moving the whole subtree to trash.
/// Unlike [`delete_folder`] (which only removes an empty folder), this is
/// recoverable. The index is rebuilt so the removed notes leave it immediately.
#[tauri::command]
#[specta::specta]
pub fn delete_folder_recursive(state: State<AppEngine>, path: String) -> CmdResult<()> {
    state.with(|e| {
        trash::trash_folder(&e.vault_path, &path)?;
        search::build_index(&e.db, &e.vault_path)
    })
}

// ── Search & links ─────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn search(
    state: State<AppEngine>,
    query: String,
    folder: Option<String>,
    tag: Option<String>,
) -> CmdResult<Vec<SearchResult>> {
    state.with(|e| search::search(&e.db, &query, folder.as_deref(), tag.as_deref()))
}

#[tauri::command]
#[specta::specta]
pub fn quick_search(state: State<AppEngine>, query: String) -> CmdResult<Vec<NoteSummary>> {
    state.with(|e| search::quick_search(&e.db, &query))
}

/// Distinct note tags with per-tag note counts, for the tag browser/autocomplete.
#[tauri::command]
#[specta::specta]
pub fn list_tags(state: State<AppEngine>) -> CmdResult<Vec<TagCount>> {
    state.with(|e| search::list_tags(&e.db))
}

/// Notes linking to `title`, each with the snippet line(s) where they do.
///
/// `async` + `spawn_blocking`: this reads candidate note bodies to extract the
/// context snippet, which on a OneDrive/iCloud vault could hydrate a file over
/// the network. Off the main thread, that never freezes the UI (online-only
/// placeholders are skipped in the core, so they don't block at all).
#[tauri::command]
#[specta::specta]
pub async fn backlinks(app: AppHandle, title: String) -> CmdResult<Vec<LinkReference>> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppEngine>()
            .with(|e| links::backlinks(&e.db, &e.vault_path, &title))
    })
    .await
    .map_err(|e| CommandError::internal(format!("backlinks task panicked: {e}")))?
}

/// Notes that name `title` without linking it, each with the bare-mention line(s).
/// `async` + `spawn_blocking` for the same reason as [`backlinks`].
#[tauri::command]
#[specta::specta]
pub async fn unlinked_mentions(
    app: AppHandle,
    title: String,
    self_path: String,
) -> CmdResult<Vec<LinkReference>> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppEngine>()
            .with(|e| links::unlinked_mentions(&e.db, &e.vault_path, &title, &self_path))
    })
    .await
    .map_err(|e| CommandError::internal(format!("unlinked_mentions task panicked: {e}")))?
}

/// Turn the first bare mention of `title` on `line` of `path` into a `[[title]]`
/// wikilink (then re-index). Returns the updated note.
#[tauri::command]
#[specta::specta]
pub fn link_mention(
    state: State<AppEngine>,
    path: String,
    title: String,
    line: usize,
) -> CmdResult<Note> {
    state.with(|e| {
        novalis_core::notes::link_mention(&e.db, &e.vault_path, &e.data_dir, &path, &title, line)
    })
}

/// The 1-hop link neighborhood of `path` for the local graph view. Index-only.
#[tauri::command]
#[specta::specta]
pub fn note_graph(state: State<AppEngine>, path: String) -> CmdResult<NoteGraph> {
    state.with(|e| links::note_graph(&e.db, &path))
}

// ── Vault info / index ──────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn get_vault_info(state: State<AppEngine>) -> CmdResult<VaultInfo> {
    state.with(|e| Ok(stats::vault_info(&e.vault_path)))
}

#[tauri::command]
#[specta::specta]
pub fn get_vault_stats(state: State<AppEngine>) -> CmdResult<VaultStats> {
    state.with(|e| Ok(stats::vault_stats(&e.vault_path)))
}

/// Rebuild the entire index from the vault. Returns the number of notes indexed.
///
/// `async` + `spawn_blocking` for the same reason as [`open_vault`]: a full
/// rebuild reads every note and would freeze the UI if run on the main thread.
#[tauri::command]
#[specta::specta]
pub async fn reindex_vault(app: AppHandle) -> CmdResult<u32> {
    let engine_app = app.clone();
    let count = tauri::async_runtime::spawn_blocking(move || {
        engine_app.state::<AppEngine>().with(|e| {
            search::build_index(&e.db, &e.vault_path)?;
            let n: i64 =
                e.db.query_row("SELECT COUNT(*) FROM note_meta", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap_or(0);
            Ok(n as u32)
        })
    })
    .await
    .map_err(|e| CommandError::internal(format!("reindex_vault task panicked: {e}")))??;
    let _ = app.emit("reindexed-event", ());
    Ok(count)
}

/// Re-scan from disk (pull model — used on mobile/foreground and manual refresh).
/// For M1 this is a full rebuild; incremental mtime scanning comes later.
#[tauri::command]
#[specta::specta]
pub async fn rescan_vault(app: AppHandle) -> CmdResult<u32> {
    reindex_vault(app).await
}

// ── Conflicts ──────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn list_conflicts(state: State<AppEngine>) -> CmdResult<Vec<ConflictFile>> {
    state.with(|e| Ok(conflict::list_conflicts(&e.vault_path)))
}

#[tauri::command]
#[specta::specta]
pub fn conflict_diff(
    state: State<AppEngine>,
    original: String,
    conflict: String,
) -> CmdResult<ConflictDiff> {
    state.with(|e| conflict::conflict_diff(&e.vault_path, &original, &conflict))
}

#[tauri::command]
#[specta::specta]
pub fn resolve_conflict(
    state: State<AppEngine>,
    req: ResolveConflictRequest,
) -> CmdResult<Option<String>> {
    state.with(|e| conflict::resolve_conflict(&e.db, &e.vault_path, &req))
}

// ── Trash ──────────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn list_trash(state: State<AppEngine>) -> CmdResult<Vec<TrashItem>> {
    state.with(|e| trash::list_trash(&e.vault_path))
}

#[tauri::command]
#[specta::specta]
pub fn restore_trash(state: State<AppEngine>, id: String) -> CmdResult<String> {
    state.with(|e| {
        let restored = trash::restore_note(&e.vault_path, &id)?;
        change::reindex_path(&e.db, &e.vault_path, &restored)?;
        Ok(restored)
    })
}

#[tauri::command]
#[specta::specta]
pub fn delete_trash_item(state: State<AppEngine>, id: String) -> CmdResult<()> {
    state.with(|e| trash::delete_trash_item(&e.vault_path, &id))
}

#[tauri::command]
#[specta::specta]
pub fn empty_trash(state: State<AppEngine>) -> CmdResult<u32> {
    state.with(|e| trash::empty_trash(&e.vault_path).map(|n| n as u32))
}

// ── Version history ────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn list_versions(state: State<AppEngine>, path: String) -> CmdResult<Vec<VersionMeta>> {
    state.with(|e| novalis_core::versions::list_versions(&e.data_dir, &path))
}

#[tauri::command]
#[specta::specta]
pub fn read_version(
    state: State<AppEngine>,
    path: String,
    version_id: String,
) -> CmdResult<String> {
    state.with(|e| novalis_core::versions::read_version(&e.data_dir, &path, &version_id))
}

/// Line-diff a snapshot against the current note ("what changed since this version").
#[tauri::command]
#[specta::specta]
pub fn diff_version(
    state: State<AppEngine>,
    path: String,
    version_id: String,
) -> CmdResult<Vec<DiffLine>> {
    state.with(|e| novalis_core::versions::diff(&e.data_dir, &e.vault_path, &path, &version_id))
}

#[tauri::command]
#[specta::specta]
pub fn restore_version(
    state: State<AppEngine>,
    path: String,
    version_id: String,
) -> CmdResult<Note> {
    state.with(|e| {
        novalis_core::notes::restore_version(&e.db, &e.vault_path, &e.data_dir, &path, &version_id)
    })
}

// ── Preferences ────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn get_preferences(state: State<AppEngine>) -> CmdResult<Preferences> {
    state.with(|e| Ok(config::read_preferences(&e.vault_path)))
}

#[tauri::command]
#[specta::specta]
pub fn set_preferences(state: State<AppEngine>, prefs: Preferences) -> CmdResult<()> {
    state.with(|e| config::write_preferences(&e.vault_path, &prefs))
}

// ── Tasks ────────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn list_tasks(state: State<AppEngine>, query: TaskQuery) -> CmdResult<Vec<Task>> {
    state.with(|e| task_svc::list(&e.db, &query))
}

#[tauri::command]
#[specta::specta]
pub fn create_task(state: State<AppEngine>, req: CreateTaskRequest) -> CmdResult<Task> {
    state.with(|e| task_svc::create(&e.db, &e.vault_path, req))
}

#[tauri::command]
#[specta::specta]
pub fn toggle_task(state: State<AppEngine>, id: String) -> CmdResult<bool> {
    state.with(|e| task_svc::toggle(&e.db, &e.vault_path, &id))
}

#[tauri::command]
#[specta::specta]
pub fn set_task_status(state: State<AppEngine>, id: String, status: String) -> CmdResult<()> {
    state.with(|e| task_svc::set_status(&e.db, &e.vault_path, &id, &status))
}

/// Set or clear an annotation on a task. `field` is one of `project` | `epic` |
/// `priority` | `due`; `value = null` removes it.
#[tauri::command]
#[specta::specta]
pub fn update_task(
    state: State<AppEngine>,
    id: String,
    field: String,
    value: Option<String>,
) -> CmdResult<()> {
    state.with(|e| task_svc::update_task(&e.db, &e.vault_path, &id, &field, value.as_deref()))
}

/// Delete a task (remove its checkbox line from the source note).
#[tauri::command]
#[specta::specta]
pub fn delete_task(state: State<AppEngine>, id: String) -> CmdResult<()> {
    state.with(|e| task_svc::delete_task(&e.db, &e.vault_path, &id))
}

#[tauri::command]
#[specta::specta]
pub fn quick_capture(state: State<AppEngine>, req: CaptureRequest) -> CmdResult<String> {
    state.with(|e| task_svc::quick_capture(&e.db, &e.vault_path, req))
}

// ── Export / templates / media ─────────────────────────────────────────────

/// Export a note to HTML or DOCX, prompting for a save location. Returns the
/// saved path, or `None` if the user cancelled.
#[tauri::command]
#[specta::specta]
pub fn export_note(
    app: AppHandle,
    state: State<AppEngine>,
    path: String,
    format: String,
) -> CmdResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;

    let (default_name, bytes) = state.with(|e| {
        let note = vault_fs::read_note(&e.vault_path, &path)?;
        let (_, body) = frontmatter::parse_frontmatter(&note.content);
        let stem = note.path.rsplit('/').next().unwrap_or("note").to_string();
        match format.as_str() {
            "html" => Ok((
                stem.replace(".md", ".html"),
                export::note_html(&note.title, &body).into_bytes(),
            )),
            "docx" => Ok((
                stem.replace(".md", ".docx"),
                export::note_docx(&note.title, &body)?,
            )),
            other => Err(CoreError::BadRequest(format!(
                "Unknown export format: {other}"
            ))),
        }
    })?;

    let target = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .blocking_save_file();
    let Some(fp) = target else {
        return Ok(None);
    };
    let out = fp
        .into_path()
        .map_err(|e| CommandError::internal(e.to_string()))?;
    std::fs::write(&out, &bytes).map_err(|e| CommandError::from(CoreError::Io(e)))?;
    Ok(Some(out.to_string_lossy().to_string()))
}

#[tauri::command]
#[specta::specta]
pub fn list_templates(state: State<AppEngine>) -> CmdResult<Vec<NoteTemplate>> {
    state.with(|e| templates::list(&e.data_dir))
}

#[tauri::command]
#[specta::specta]
pub fn create_template(
    state: State<AppEngine>,
    name: String,
    description: Option<String>,
    content: String,
) -> CmdResult<NoteTemplate> {
    state.with(|e| templates::create(&e.data_dir, name, description, content))
}

#[tauri::command]
#[specta::specta]
pub fn delete_template(state: State<AppEngine>, id: String) -> CmdResult<()> {
    state.with(|e| templates::delete(&e.data_dir, &id))
}

/// Render a template body's `{{...}}` variables (for inserting into the open
/// note). Pure — shares the exact substitution used on the create-note path.
#[tauri::command]
#[specta::specta]
pub fn render_template(content: String, title: Option<String>) -> String {
    templates::render_template(&content, &templates::TemplateContext { title })
}

/// Save a pasted/dropped image into the vault `media/` folder; returns the
/// vault-relative path for embedding as `![](...)`.
#[tauri::command]
#[specta::specta]
pub fn save_pasted_image(
    state: State<AppEngine>,
    bytes: Vec<u8>,
    ext: String,
) -> CmdResult<String> {
    state.with(|e| media::save_image(&e.vault_path, &bytes, &ext))
}

// ── Calendar ───────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn list_events(
    state: State<AppEngine>,
    range_start: String,
    range_end: String,
) -> CmdResult<Vec<CalendarEvent>> {
    state.with(|e| calendar::list_events(&e.db, &range_start, &range_end))
}

#[tauri::command]
#[specta::specta]
pub fn create_event(state: State<AppEngine>, input: EventInput) -> CmdResult<CalendarEvent> {
    state.with(|e| calendar::create_event(&e.db, &e.vault_path, input))
}

#[tauri::command]
#[specta::specta]
pub fn update_event(state: State<AppEngine>, input: EventInput) -> CmdResult<CalendarEvent> {
    state.with(|e| calendar::update_event(&e.db, &e.vault_path, input))
}

#[tauri::command]
#[specta::specta]
pub fn delete_event(state: State<AppEngine>, note_path: String) -> CmdResult<()> {
    state.with(|e| calendar::delete_event(&e.db, &e.vault_path, &note_path))
}

#[tauri::command]
#[specta::specta]
pub fn get_agenda(
    state: State<AppEngine>,
    range_start: String,
    range_end: String,
) -> CmdResult<Vec<AgendaItem>> {
    state.with(|e| calendar::get_agenda(&e.db, &range_start, &range_end))
}

#[tauri::command]
#[specta::specta]
pub fn list_calendar_sources(state: State<AppEngine>) -> CmdResult<Vec<CalendarSourceConfig>> {
    state.with(|e| Ok(calendar::source::list_sources(&e.vault_path)))
}

#[tauri::command]
#[specta::specta]
pub fn add_calendar_source(state: State<AppEngine>, cfg: CalendarSourceConfig) -> CmdResult<()> {
    state.with(|e| calendar::source::add_source(&e.vault_path, cfg))
}

#[tauri::command]
#[specta::specta]
pub fn remove_calendar_source(state: State<AppEngine>, id: String) -> CmdResult<()> {
    state.with(|e| {
        calendar::source::remove_source(&e.vault_path, &id)?;
        novalis_core::index::events::clear_source(&e.db, &id)
    })
}

/// Refresh a source's cached events. ICS-URL sources are fetched over HTTP;
/// Google/Outlook sources use stored OAuth tokens. Returns the number cached.
#[tauri::command]
#[specta::specta]
pub fn refresh_calendar_source(state: State<AppEngine>, id: String) -> CmdResult<u32> {
    let (kind, url) = state.with(|e| {
        calendar::source::list_sources(&e.vault_path)
            .into_iter()
            .find(|s| s.id == id)
            .ok_or_else(|| CoreError::NotFound(format!("Calendar source not found: {id}")))
            .map(|s| (s.kind, s.url))
    })?;

    // Broad rolling window for the cache.
    let today = chrono::Local::now().date_naive();
    let start = (today - chrono::Days::new(31))
        .format("%Y-%m-%d")
        .to_string();
    let end = (today + chrono::Days::new(365))
        .format("%Y-%m-%d")
        .to_string();

    // Network fetch happens outside the engine lock.
    let events = match kind.as_str() {
        "icsUrl" => {
            let Some(url) = url else {
                return Ok(0);
            };
            let bytes = reqwest::blocking::get(&url)
                .and_then(|r| r.bytes())
                .map_err(|err| CommandError::internal(format!("fetch failed: {err}")))?;
            calendar::source::import_ics(&bytes, &id)?
        }
        "google" | "outlook" => crate::oauth::fetch_events(&kind, &id, &start, &end)?,
        _ => return Ok(0),
    };

    state.with(|e| {
        novalis_core::index::events::clear_source(&e.db, &id)?;
        for ev in &events {
            novalis_core::index::events::upsert(&e.db, ev)?;
        }
        Ok(events.len() as u32)
    })
}

// ── OAuth (Google / Outlook) ──────────────────────────────────────────────

/// Run the interactive OAuth flow for `provider` ("google" | "outlook") and
/// register it as a calendar source.
#[tauri::command]
#[specta::specta]
pub fn oauth_begin(app: AppHandle, state: State<AppEngine>, provider: String) -> CmdResult<()> {
    crate::oauth::connect(&app, &provider)?;
    let name = match provider.as_str() {
        "google" => "Google Calendar",
        "outlook" => "Outlook Calendar",
        _ => "Calendar",
    };
    state.with(|e| {
        calendar::source::add_source(
            &e.vault_path,
            CalendarSourceConfig {
                id: provider.clone(),
                kind: provider.clone(),
                name: name.to_string(),
                url: None,
                enabled: true,
            },
        )
    })
}

/// Whether a provider is currently connected.
#[tauri::command]
#[specta::specta]
pub fn oauth_status(provider: String) -> bool {
    crate::oauth::is_connected(&provider)
}

/// Disconnect a provider: clear tokens, its source, and its cached events.
#[tauri::command]
#[specta::specta]
pub fn oauth_disconnect(state: State<AppEngine>, provider: String) -> CmdResult<()> {
    crate::oauth::disconnect(&provider)?;
    state.with(|e| {
        calendar::source::remove_source(&e.vault_path, &provider)?;
        novalis_core::index::events::clear_source(&e.db, &provider)
    })
}

/// Import an `.ics` file (native picker), creating own events. Returns the count.
#[tauri::command]
#[specta::specta]
pub fn import_ics(app: AppHandle, state: State<AppEngine>) -> CmdResult<u32> {
    use tauri_plugin_dialog::DialogExt;
    let Some(fp) = app
        .dialog()
        .file()
        .add_filter("iCalendar", &["ics"])
        .blocking_pick_file()
    else {
        return Ok(0);
    };
    let path = fp
        .into_path()
        .map_err(|e| CommandError::internal(e.to_string()))?;
    let bytes = std::fs::read(&path).map_err(|e| CommandError::from(CoreError::Io(e)))?;
    let events = calendar::source::import_ics(&bytes, "import")?;

    state.with(|e| {
        for ev in &events {
            calendar::create_event(&e.db, &e.vault_path, event_to_input(ev))?;
        }
        Ok(events.len() as u32)
    })
}

/// Export events in a range to an `.ics` file (save dialog). Returns saved path.
#[tauri::command]
#[specta::specta]
pub fn export_ics(
    app: AppHandle,
    state: State<AppEngine>,
    range_start: String,
    range_end: String,
) -> CmdResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let ics = state.with(|e| {
        Ok(calendar::source::export_ics(&calendar::list_events(
            &e.db,
            &range_start,
            &range_end,
        )?))
    })?;
    let Some(fp) = app
        .dialog()
        .file()
        .set_file_name("novalis-calendar.ics")
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let out = fp
        .into_path()
        .map_err(|e| CommandError::internal(e.to_string()))?;
    std::fs::write(&out, ics.as_bytes()).map_err(|e| CommandError::from(CoreError::Io(e)))?;
    Ok(Some(out.to_string_lossy().to_string()))
}

fn event_to_input(e: &CalendarEvent) -> EventInput {
    let date = e.start.get(..10).unwrap_or(&e.start).to_string();
    let timed = !e.all_day && e.start.len() >= 16;
    EventInput {
        title: e.title.clone(),
        date,
        all_day: e.all_day,
        start_time: timed.then(|| e.start[11..16].to_string()),
        end_time: e
            .end
            .as_ref()
            .filter(|x| !e.all_day && x.len() >= 16)
            .map(|x| x[11..16].to_string()),
        rrule: e.rrule.clone(),
        location: e.location.clone(),
        note_path: None,
    }
}

// ── Plugins ────────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn list_plugins(state: State<AppEngine>) -> CmdResult<Vec<PluginInfo>> {
    state.with(|e| Ok(novalis_core::plugins::list(&e.vault_path)))
}

#[tauri::command]
#[specta::specta]
pub fn set_plugin_enabled(state: State<AppEngine>, id: String, enabled: bool) -> CmdResult<()> {
    state.with(|e| novalis_core::plugins::set_enabled(&e.vault_path, &id, enabled))
}

#[tauri::command]
#[specta::specta]
pub fn read_plugin_source(state: State<AppEngine>, id: String) -> CmdResult<String> {
    state.with(|e| novalis_core::plugins::read_source(&e.vault_path, &id))
}

/// Build a stable, filesystem-safe key for a vault path (used to name its
/// per-vault app-data directory).
fn vault_key(vault: &std::path::Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    vault.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Current time in epoch milliseconds (for recent-vault timestamps).
fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_vault_accepts_existing_dir_and_rejects_missing() {
        // Uses the OS temp dir (no extra dev-deps); create_dir_all is idempotent.
        let dir = std::env::temp_dir().join("novalis-validate-vault-test");
        std::fs::create_dir_all(&dir).unwrap();
        let ok = validate_vault(dir.to_string_lossy().to_string());
        assert!(ok.is_ok(), "an existing directory validates");

        let missing = dir.join("does-not-exist-subdir");
        let err = validate_vault(missing.to_string_lossy().to_string());
        assert!(err.is_err(), "a missing path is rejected");
        assert_eq!(err.unwrap_err().kind, "notFound");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
