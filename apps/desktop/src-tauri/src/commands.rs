//! Tauri command surface. Each command is a thin wrapper: lock the engine and
//! call a `novalis_core` function. The vault/index lifecycle lives in
//! [`open_vault`] / [`close_vault`].

use std::path::PathBuf;
use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, State};

use novalis_core::change;
use novalis_core::conflict;
use novalis_core::index::{links, schema, search};
use novalis_core::models::{
    CaptureRequest, ConflictDiff, ConflictFile, CreateNoteRequest, CreateTaskRequest, FolderNode,
    Note, NoteSummary, Preferences, ResolveConflictRequest, SearchResult, Task, TaskQuery,
    UpdateMetaRequest, VaultInfo, VaultStats,
};
use novalis_core::tasks::service as task_svc;
use novalis_core::trash::{self, TrashItem};
use novalis_core::vault::{config, fs as vault_fs, stats};
use novalis_core::{AppInfo, CoreError};

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

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::internal(format!("cannot resolve app data dir: {e}")))?
        .join("vaults")
        .join(vault_key(&vault_path));
    config::ensure_data_dirs(&data_dir).map_err(CoreError::Io)?;

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

    // Bump the watcher generation so any previous watcher exits, then start a
    // fresh one for this vault.
    let generation = crate::watcher::WATCH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    crate::watcher::start(app.clone(), vault_path, generation);

    let _ = app.emit("reindexed-event", ());
    Ok(info)
}

/// Open (or create) a vault at `path`.
#[tauri::command]
#[specta::specta]
pub fn open_vault(app: AppHandle, path: String) -> CmdResult<VaultInfo> {
    open_vault_impl(&app, &path)
}

/// Show a native folder picker; returns the chosen path, if any.
#[tauri::command]
#[specta::specta]
pub fn pick_vault_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|fp| fp.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
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

// ── Notes ───────────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn list_notes(state: State<AppEngine>) -> CmdResult<Vec<NoteSummary>> {
    state.with(|e| Ok(novalis_core::notes::list(&e.vault_path)))
}

#[tauri::command]
#[specta::specta]
pub fn get_note(state: State<AppEngine>, path: String) -> CmdResult<Note> {
    state.with(|e| novalis_core::notes::get(&e.vault_path, &path))
}

#[tauri::command]
#[specta::specta]
pub fn create_note(state: State<AppEngine>, req: CreateNoteRequest) -> CmdResult<Note> {
    state.with(|e| novalis_core::notes::create(&e.db, &e.vault_path, &e.data_dir, req))
}

#[tauri::command]
#[specta::specta]
pub fn update_note(state: State<AppEngine>, path: String, content: String) -> CmdResult<Note> {
    state.with(|e| novalis_core::notes::update(&e.db, &e.vault_path, &path, &content))
}

#[tauri::command]
#[specta::specta]
pub fn update_note_meta(state: State<AppEngine>, req: UpdateMetaRequest) -> CmdResult<Note> {
    state.with(|e| novalis_core::notes::update_meta(&e.db, &e.vault_path, req))
}

#[tauri::command]
#[specta::specta]
pub fn move_note(state: State<AppEngine>, path: String, new_path: String) -> CmdResult<Note> {
    state.with(|e| novalis_core::notes::move_note(&e.db, &e.vault_path, &path, &new_path))
}

#[tauri::command]
#[specta::specta]
pub fn duplicate_note(state: State<AppEngine>, path: String) -> CmdResult<Note> {
    state.with(|e| novalis_core::notes::duplicate(&e.db, &e.vault_path, &path))
}

#[tauri::command]
#[specta::specta]
pub fn delete_note(state: State<AppEngine>, path: String) -> CmdResult<()> {
    state.with(|e| novalis_core::notes::delete(&e.db, &e.vault_path, &e.data_dir, &path))
}

// ── Folders ────────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn get_folder_tree(state: State<AppEngine>) -> CmdResult<FolderNode> {
    state.with(|e| Ok(vault_fs::list_folders(&e.vault_path)))
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

#[tauri::command]
#[specta::specta]
pub fn backlinks(state: State<AppEngine>, title: String) -> CmdResult<Vec<NoteSummary>> {
    state.with(|e| links::backlinks(&e.db, &title))
}

#[tauri::command]
#[specta::specta]
pub fn unlinked_mentions(
    state: State<AppEngine>,
    title: String,
    self_path: String,
) -> CmdResult<Vec<NoteSummary>> {
    state.with(|e| links::unlinked_mentions(&e.db, &title, &self_path))
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
#[tauri::command]
#[specta::specta]
pub fn reindex_vault(app: AppHandle, state: State<AppEngine>) -> CmdResult<u32> {
    let count = state.with(|e| {
        search::build_index(&e.db, &e.vault_path)?;
        let n: i64 =
            e.db.query_row("SELECT COUNT(*) FROM note_meta", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0);
        Ok(n as u32)
    })?;
    let _ = app.emit("reindexed-event", ());
    Ok(count)
}

/// Re-scan from disk (pull model — used on mobile/foreground and manual refresh).
/// For M1 this is a full rebuild; incremental mtime scanning comes later.
#[tauri::command]
#[specta::specta]
pub fn rescan_vault(app: AppHandle, state: State<AppEngine>) -> CmdResult<u32> {
    reindex_vault(app, state)
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
    state.with(|e| trash::list_trash(&e.data_dir))
}

#[tauri::command]
#[specta::specta]
pub fn restore_trash(state: State<AppEngine>, id: String) -> CmdResult<String> {
    state.with(|e| {
        let restored = trash::restore_note(&e.vault_path, &e.data_dir, &id)?;
        change::reindex_path(&e.db, &e.vault_path, &restored)?;
        Ok(restored)
    })
}

#[tauri::command]
#[specta::specta]
pub fn empty_trash(state: State<AppEngine>) -> CmdResult<u32> {
    state.with(|e| trash::empty_trash(&e.data_dir).map(|n| n as u32))
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

#[tauri::command]
#[specta::specta]
pub fn quick_capture(state: State<AppEngine>, req: CaptureRequest) -> CmdResult<String> {
    state.with(|e| task_svc::quick_capture(&e.db, &e.vault_path, req))
}

/// Build a stable, filesystem-safe key for a vault path (used to name its
/// per-vault app-data directory).
fn vault_key(vault: &std::path::Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    vault.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}
