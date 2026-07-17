//! Tauri command surface. Each command is a thin wrapper: lock the engine and
//! call a `novalis_core` function. The vault/index lifecycle lives in
//! [`open_vault`] / [`close_vault`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use novalis_core::change;
use novalis_core::conflict;
use novalis_core::index::{blocks, links, properties, query as index_query, schema, search};
use novalis_core::models::{
    AgendaItem, BlockHit, BlockResolution, CalendarEvent, CalendarSourceConfig, CaptureRequest,
    ConflictDiff, ConflictFile, CreateNoteRequest, CreateTaskRequest, EmbedResolution, EventInput,
    FolderNode, FullGraph, GitConflict, GitResolution, GitStatus, GitSyncOutcome, LinkReference,
    MeetingNoteResult, Note, NoteGraph, NotePropertyEntry, NoteRelations, NoteSummary,
    NoteTemplate, PluginInfo, Preferences, PropertyValue, QueryResult, ResolveConflictRequest,
    RollupOp, RollupResult, SearchResult, SyncOutcome, SyncStatus, TagCount, Task, TaskQuery,
    UpdateMetaRequest, VaultInfo, VaultStats,
};
use novalis_core::review::{self, ReviewDigest};
use novalis_core::tasks::service as task_svc;
use novalis_core::trash::{self, TrashItem};
use novalis_core::vault::{canvas, config, frontmatter, fs as vault_fs, stats};
use novalis_core::versions::{DiffLine, VersionMeta};
use novalis_core::{calendar, export, git, media, pdf, templates, AppInfo, CoreError};

use crate::engine::{AppEngine, CommandError, Engine};

type CmdResult<T> = Result<T, CommandError>;

// ── Self-write suppression ──────────────────────────────────────────────────
//
// App-initiated writes still hit the file watcher, which would redundantly
// reindex the path and echo a `note-changed`/`note-deleted` event back at the
// frontend for a change it just made (a storm on folder moves). Write commands
// register the paths they touch; the watcher skips events for paths registered
// within [`SELF_WRITE_WINDOW`].

/// How long after an app-initiated write the watcher treats events for that
/// path as self-inflicted. Comfortably covers the watcher's 300ms debounce
/// without masking real external edits for long.
const SELF_WRITE_WINDOW: Duration = Duration::from_secs(2);

/// Vault-relative (forward-slashed) paths the app recently wrote, with when.
static RECENT_SELF_WRITES: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Record that the app itself just wrote (or removed) `path`. Prunes expired
/// entries so the map can't grow unboundedly.
pub(crate) fn mark_self_write(path: &str) {
    let now = Instant::now();
    let mut map = RECENT_SELF_WRITES.lock().unwrap_or_else(|p| p.into_inner());
    map.retain(|_, t| now.duration_since(*t) < SELF_WRITE_WINDOW);
    map.insert(path.to_string(), now);
}

/// Whether the app wrote `path` within the suppression window.
#[cfg(desktop)] // consumed by the file watcher, which is desktop-only
pub(crate) fn is_recent_self_write(path: &str) -> bool {
    RECENT_SELF_WRITES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(path)
        .is_some_and(|t| t.elapsed() < SELF_WRITE_WINDOW)
}

/// Pass through a note-returning command result, registering the note's path
/// as a self-write on success.
fn track_note_write(result: CmdResult<Note>) -> CmdResult<Note> {
    if let Ok(note) = &result {
        mark_self_write(&note.path);
    }
    result
}

/// Collect the vault-relative (forward-slashed) paths of all `.md` files under
/// `folder_rel`, so bulk operations (folder move/trash) can register the whole
/// subtree as self-writes. Hidden entries are skipped like the watcher does.
fn collect_md_rel_paths(vault: &std::path::Path, folder_rel: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(vault.join(folder_rel)) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let rel = if folder_rel.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", folder_rel.trim_end_matches('/'), name)
        };
        if entry.path().is_dir() {
            collect_md_rel_paths(vault, &rel, out);
        } else if name.ends_with(".md") {
            out.push(rel);
        }
    }
}

/// Returns app/build info from the core. Works without a vault open.
#[tauri::command]
#[specta::specta]
pub fn app_info() -> AppInfo {
    novalis_core::app_info()
}

/// Which platform this shell was built for. The frontend adapts vault
/// onboarding: mobile has no folder picker — the vault lives app-private and
/// is populated via the git adoption path (MOBILE.md).
#[tauri::command]
#[specta::specta]
pub fn platform_info() -> String {
    #[cfg(target_os = "android")]
    return "android".to_string();
    #[cfg(target_os = "ios")]
    return "ios".to_string();
    #[cfg(desktop)]
    "desktop".to_string()
}

/// The app-private default vault location used by mobile onboarding. Works
/// without a vault open. Creates the directory so the returned path passes
/// the store's validate-before-open check on first use.
#[tauri::command]
#[specta::specta]
pub fn default_vault_path(app: AppHandle) -> CmdResult<String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::internal(format!("cannot resolve app data dir: {e}")))?
        .join("vault");
    std::fs::create_dir_all(&dir).map_err(CoreError::Io)?;
    Ok(dir.to_string_lossy().to_string())
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
    // Incremental startup scan: reindex only new/changed notes and drop vanished
    // ones, comparing on-disk mtimes against the last-session index. A steady
    // reopen of an unchanged vault costs only a directory walk + stats (no body
    // reads / FTS re-tokenization / cloud hydration). A `SCHEMA_VERSION` bump has
    // already dropped+recreated the tables in `open_db`, so the first scan after
    // an upgrade reindexes everything (empty index ⇒ every note is "new"); the
    // explicit rebuild path (`reindex_vault`) still does a full `build_index`.
    search::incremental_index(&db, &vault_path)?;

    let info = stats::vault_info(&vault_path);

    // Poison recovery matches [`AppEngine::with`]: the state is replaced
    // wholesale here, so a previously poisoned lock is safe to reclaim.
    *state.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(Engine {
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
        // Git auto-committer shares the watcher's generation/lifecycle.
        crate::autocommit::start(app.clone(), vault_path.clone(), generation);
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
    #[cfg(desktop)]
    {
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
    // Mobile has no blocking folder picker — and the mobile vault strategy
    // (MOBILE.md) never needs one: the vault lives app-private and is
    // populated via the git adoption path.
    #[cfg(mobile)]
    {
        let _ = app;
        None
    }
}

/// Close the current vault (drops the index connection).
#[tauri::command]
#[specta::specta]
pub fn close_vault(state: State<AppEngine>) -> CmdResult<()> {
    *state.0.lock().unwrap_or_else(|p| p.into_inner()) = None;
    // Invalidate the vault-scoped background threads (watcher + git
    // auto-committer): they key their lifetime to this generation. Without
    // the bump the committer would keep WRITING into the closed vault.
    #[cfg(desktop)]
    crate::watcher::WATCH_GEN.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Generate the bundled "Novalis Tour" demo vault under `parent` (a folder the
/// user picked) and return the created vault's path, which the frontend then
/// opens as the active vault.
///
/// We never write into `parent` directly — we create a fresh, empty
/// `Novalis Tour` subfolder (deduped to `Novalis Tour 2`, … if one is already
/// there), so an existing folder's files are never touched. The generator
/// itself also refuses a non-empty target.
#[tauri::command]
#[specta::specta]
pub fn create_tour_vault(parent: String) -> CmdResult<String> {
    let base = PathBuf::from(&parent);
    if !base.is_dir() {
        return Err(CoreError::NotFound(format!("folder not found: {parent}")).into());
    }
    // Pick the first free `Novalis Tour[ N]` name so we always land on an empty
    // directory the generator can own.
    let mut target = base.join("Novalis Tour");
    let mut n = 2;
    while target.exists() {
        target = base.join(format!("Novalis Tour {n}"));
        n += 1;
    }
    novalis_core::tour::generate(&target)?;
    Ok(target.to_string_lossy().to_string())
}

/// Path of the currently open vault, if any.
#[tauri::command]
#[specta::specta]
pub fn current_vault(state: State<AppEngine>) -> CmdResult<Option<String>> {
    let guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
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

/// Served straight from the index (no disk reads), so it stays fast on a
/// cloud-synced vault — [`novalis_core::index::list_summaries`] returns the same
/// [`NoteSummary`] shape a from-disk walk would (parity is pinned by a test in
/// `index::search`), and the file watcher / incremental scan keep the index in
/// step with the vault.
#[tauri::command]
#[specta::specta]
pub fn list_notes(state: State<AppEngine>) -> CmdResult<Vec<NoteSummary>> {
    state.with(|e| novalis_core::index::list_summaries(&e.db))
}

/// `async` + `spawn_blocking`: reading a note on a OneDrive/iCloud vault may
/// hydrate an online-only file over the network. Off the main thread, that read
/// never blocks the UI or other commands (the frontend masks it with a loading
/// state and prefetch-on-hover).
#[tauri::command]
#[specta::specta]
pub async fn get_note(app: AppHandle, path: String) -> CmdResult<Note> {
    // Snapshot the vault path under a brief lock, then read the file OFF the
    // lock: a cloud hydration must never freeze the whole command surface.
    let vault = vault_path_snapshot(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        novalis_core::notes::get(&vault, &path).map_err(CommandError::from)
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
    track_note_write(
        state.with(|e| novalis_core::notes::create(&e.db, &e.vault_path, &e.data_dir, req)),
    )
}

/// `async` + `spawn_blocking`: the save does a version snapshot + write +
/// read-back (file IO that on a cloud-synced vault is slow), so it runs OFF the
/// engine lock — the lock is re-acquired only for the pure-DB index upsert.
/// Indexing from the just-written summary + content is identical to the old
/// in-lock `notes::update` (the file exists, so `reindex_path`'s remove branch
/// never applied).
#[tauri::command]
#[specta::specta]
pub async fn update_note(app: AppHandle, path: String, content: String) -> CmdResult<Note> {
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<Note> {
        let state = app.state::<AppEngine>();
        // Brief lock: snapshot the paths the off-lock write needs.
        let (vault, data_dir) = state.with(|e| Ok((e.vault_path.clone(), e.data_dir.clone())))?;
        // File IO OFF the lock.
        let (note, summary) =
            novalis_core::notes::update_write(&vault, &data_dir, &path, &content)?;
        // Re-acquire only for the index upsert + mtime stamp (pure DB).
        state.with(|e| {
            search::index_note(&e.db, &summary, &note.content)?;
            if let Some(ms) = std::fs::metadata(vault.join(&path))
                .ok()
                .as_ref()
                .and_then(vault_fs::file_mtime_ms)
            {
                search::stamp_mtime(&e.db, &path, ms)?;
            }
            Ok(())
        })?;
        mark_self_write(&note.path);
        Ok(note)
    })
    .await
    .map_err(|e| CommandError::internal(format!("update_note task panicked: {e}")))?
}

#[tauri::command]
#[specta::specta]
pub fn update_note_meta(state: State<AppEngine>, req: UpdateMetaRequest) -> CmdResult<Note> {
    track_note_write(state.with(|e| novalis_core::notes::update_meta(&e.db, &e.vault_path, req)))
}

#[tauri::command]
#[specta::specta]
pub fn set_property(
    state: State<AppEngine>,
    path: String,
    key: String,
    value: PropertyValue,
) -> CmdResult<Note> {
    track_note_write(
        state.with(|e| novalis_core::notes::set_property(&e.db, &e.vault_path, &path, &key, value)),
    )
}

#[tauri::command]
#[specta::specta]
pub fn remove_property(state: State<AppEngine>, path: String, key: String) -> CmdResult<Note> {
    track_note_write(
        state.with(|e| novalis_core::notes::remove_property(&e.db, &e.vault_path, &path, &key)),
    )
}

#[tauri::command]
#[specta::specta]
pub fn rename_property(
    state: State<AppEngine>,
    path: String,
    from: String,
    to: String,
) -> CmdResult<Note> {
    track_note_write(
        state.with(|e| {
            novalis_core::notes::rename_property(&e.db, &e.vault_path, &path, &from, &to)
        }),
    )
}

#[tauri::command]
#[specta::specta]
pub fn move_note(state: State<AppEngine>, path: String, new_path: String) -> CmdResult<Note> {
    let note = state.with(|e| {
        novalis_core::notes::move_note(&e.db, &e.vault_path, &e.data_dir, &path, &new_path)
    })?;
    // The old path produces a delete event, the new one a change event — both
    // echoes of this command.
    mark_self_write(&path);
    mark_self_write(&note.path);
    Ok(note)
}

#[tauri::command]
#[specta::specta]
pub fn duplicate_note(state: State<AppEngine>, path: String) -> CmdResult<Note> {
    track_note_write(state.with(|e| novalis_core::notes::duplicate(&e.db, &e.vault_path, &path)))
}

#[tauri::command]
#[specta::specta]
pub fn delete_note(state: State<AppEngine>, path: String) -> CmdResult<()> {
    state.with(|e| novalis_core::notes::delete(&e.db, &e.vault_path, &path))?;
    mark_self_write(&path);
    Ok(())
}

// ── Canvas ──────────────────────────────────────────────────────────────────
//
// A `.canvas` is a portable JSON Canvas document (Obsidian's format) stored as
// a plain vault file. The core treats it as opaque text; the frontend owns the
// schema. Canvas files aren't `.md`, so they're outside the note index and the
// file watcher — no self-write tracking is needed.

/// List every `.canvas` file in the vault.
#[tauri::command]
#[specta::specta]
pub fn list_canvases(state: State<AppEngine>) -> CmdResult<Vec<canvas::CanvasFile>> {
    state.with(|e| Ok(canvas::list(&e.vault_path)))
}

/// Read a canvas file's raw JSON content.
#[tauri::command]
#[specta::specta]
pub fn read_canvas(state: State<AppEngine>, path: String) -> CmdResult<String> {
    state.with(|e| canvas::read(&e.vault_path, &path))
}

/// Overwrite an existing canvas file atomically.
#[tauri::command]
#[specta::specta]
pub fn write_canvas(state: State<AppEngine>, path: String, content: String) -> CmdResult<()> {
    state.with(|e| canvas::write(&e.vault_path, &path, &content))
}

/// Create a new canvas file with initial JSON content.
#[tauri::command]
#[specta::specta]
pub fn create_canvas(
    state: State<AppEngine>,
    path: String,
    content: String,
) -> CmdResult<canvas::CanvasFile> {
    state.with(|e| canvas::create(&e.vault_path, &path, &content))
}

/// Permanently delete a canvas file.
#[tauri::command]
#[specta::specta]
pub fn delete_canvas(state: State<AppEngine>, path: String) -> CmdResult<()> {
    state.with(|e| canvas::delete(&e.vault_path, &path))
}

/// Reveal a note file or folder in the OS file manager (Finder/Explorer/file
/// manager), selecting the item. `path` is vault-relative (forward-slashed); an
/// empty string reveals the vault root. If the target no longer exists (e.g. a
/// brand-new note not yet flushed to disk), falls back to revealing its parent.
#[tauri::command]
#[specta::specta]
pub fn reveal_in_file_manager(
    app: AppHandle,
    state: State<AppEngine>,
    path: String,
) -> CmdResult<()> {
    use tauri_plugin_opener::OpenerExt;

    // Resolve against the vault, rejecting `..` traversal (core's read_note does
    // not guard this, so guard here).
    let abs = state.with(|e| {
        let rel = std::path::Path::new(&path);
        if rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(CoreError::BadRequest(format!(
                "path escapes the vault: {path}"
            )));
        }
        let joined = e.vault_path.join(rel);
        // Defense in depth: when both sides canonicalize, the target must stay
        // inside the vault root.
        if let (Ok(root), Ok(target)) = (e.vault_path.canonicalize(), joined.canonicalize()) {
            if !target.starts_with(&root) {
                return Err(CoreError::BadRequest(format!(
                    "path escapes the vault: {path}"
                )));
            }
        }
        Ok(joined)
    })?;

    // reveal_item_in_dir needs an existing path; fall back to the parent dir for
    // not-yet-flushed / freshly-removed items.
    let target = if abs.exists() {
        abs
    } else if let Some(parent) = abs.parent().filter(|p| p.exists()) {
        parent.to_path_buf()
    } else {
        return Err(CoreError::NotFound(format!("path not found: {path}")).into());
    };

    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|e| CommandError::internal(format!("could not reveal in file manager: {e}")))?;
    Ok(())
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

/// Notes move with the folder; rebuild the index so paths stay correct even
/// before the file watcher catches up.
///
/// `async` + `spawn_blocking` for the same reason as [`reindex_vault`]: the
/// full index rebuild reads every note and would freeze the UI on the main
/// thread.
#[tauri::command]
#[specta::specta]
pub async fn move_folder(app: AppHandle, path: String, new_path: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppEngine>().with(|e| {
            // Every note in the subtree is a self-write: old paths produce
            // delete events, new ones change events — all echoes of this
            // command (an event storm on big folders).
            let mut old_paths = Vec::new();
            collect_md_rel_paths(&e.vault_path, &path, &mut old_paths);
            vault_fs::move_folder(&e.vault_path, &path, &new_path)?;
            let (old_prefix, new_prefix) =
                (path.trim_end_matches('/'), new_path.trim_end_matches('/'));
            for old in &old_paths {
                mark_self_write(old);
                mark_self_write(&format!("{new_prefix}{}", &old[old_prefix.len()..]));
            }
            search::build_index(&e.db, &e.vault_path)
        })
    })
    .await
    .map_err(|e| CommandError::internal(format!("move_folder task panicked: {e}")))?
}

/// Delete a folder and all its contents by moving the whole subtree to trash.
/// Unlike [`delete_folder`] (which only removes an empty folder), this is
/// recoverable. The index is rebuilt so the removed notes leave it immediately.
///
/// `async` + `spawn_blocking` for the same reason as [`reindex_vault`]: the
/// full index rebuild reads every note and would freeze the UI on the main
/// thread.
#[tauri::command]
#[specta::specta]
pub async fn delete_folder_recursive(app: AppHandle, path: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppEngine>().with(|e| {
            // Every removed note produces a delete event — echoes of this
            // command. (The trash destination is under `.novalis/`, which the
            // watcher already skips as hidden.)
            let mut old_paths = Vec::new();
            collect_md_rel_paths(&e.vault_path, &path, &mut old_paths);
            trash::trash_folder(&e.vault_path, &path)?;
            for old in &old_paths {
                mark_self_write(old);
            }
            search::build_index(&e.db, &e.vault_path)
        })
    })
    .await
    .map_err(|e| CommandError::internal(format!("delete_folder_recursive task panicked: {e}")))?
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
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<Vec<LinkReference>> {
        let state = app.state::<AppEngine>();
        // Brief lock: vault path + candidate rows (pure DB). Bodies are read
        // OFF the lock so a cloud hydration never blocks other commands.
        let (vault, rows) = state.with(|e| {
            Ok((
                e.vault_path.clone(),
                links::backlink_candidates(&e.db, &title)?,
            ))
        })?;
        Ok(links::backlink_snippets(&vault, rows, &title))
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
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<Vec<LinkReference>> {
        let state = app.state::<AppEngine>();
        let (vault, rows) = state.with(|e| {
            Ok((
                e.vault_path.clone(),
                links::unlinked_mention_candidates(&e.db, &title, &self_path)?,
            ))
        })?;
        Ok(links::unlinked_mention_snippets(&vault, rows, &title))
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
    track_note_write(state.with(|e| {
        novalis_core::notes::link_mention(&e.db, &e.vault_path, &e.data_dir, &path, &title, line)
    }))
}

/// The 1-hop link neighborhood of `path` for the local graph view. Index-only.
#[tauri::command]
#[specta::specta]
pub fn note_graph(state: State<AppEngine>, path: String) -> CmdResult<NoteGraph> {
    state.with(|e| links::note_graph(&e.db, &path))
}

/// Tagged blocks whose text matches `query`, for the `((` reference
/// autocomplete. Index-only (no disk reads).
#[tauri::command]
#[specta::specta]
pub fn search_blocks(state: State<AppEngine>, query: String) -> CmdResult<Vec<BlockHit>> {
    state.with(|e| blocks::search_blocks(&e.db, &query, 20))
}

/// Resolve a `((^id))` block reference to its note + text, straight from the
/// index. `found: false` for a dangling id — never errors, never creates.
#[tauri::command]
#[specta::specta]
pub fn resolve_block(state: State<AppEngine>, block_id: String) -> CmdResult<BlockResolution> {
    state.with(|e| blocks::resolve_block(&e.db, &block_id))
}

/// Notes that reference the block `block_id` via `((^id))`, with the line(s)
/// where the reference appears (block-level backlinks).
///
/// `async` + `spawn_blocking` for the same reason as [`backlinks`]: it reads
/// candidate note bodies to extract the context snippet.
#[tauri::command]
#[specta::specta]
pub async fn block_backlinks(app: AppHandle, block_id: String) -> CmdResult<Vec<LinkReference>> {
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<Vec<LinkReference>> {
        let state = app.state::<AppEngine>();
        let (vault, rows) = state.with(|e| {
            Ok((
                e.vault_path.clone(),
                blocks::block_backlink_candidates(&e.db, &block_id)?,
            ))
        })?;
        Ok(blocks::block_backlink_snippets(&vault, rows, &block_id))
    })
    .await
    .map_err(|e| CommandError::internal(format!("block_backlinks task panicked: {e}")))?
}

/// The whole-vault link graph for the Graph view. Index-only — never reads
/// note bodies (no cloud hydration on graph open).
#[tauri::command]
#[specta::specta]
pub fn full_graph(state: State<AppEngine>) -> CmdResult<FullGraph> {
    state.with(|e| links::full_graph(&e.db))
}

// ── Typed properties + relations (query-engine foundation) ───────────────────

/// The indexed frontmatter properties of `path`, typed. Index-only.
#[tauri::command]
#[specta::specta]
pub fn note_properties(state: State<AppEngine>, path: String) -> CmdResult<Vec<NotePropertyEntry>> {
    state.with(|e| properties::properties_for(&e.db, &path))
}

/// The typed relations of `path` in both directions: the notes its frontmatter
/// points to (`outgoing`) and the notes pointing to it (`incoming`,
/// reciprocal). Index-only.
#[tauri::command]
#[specta::specta]
pub fn note_relations(state: State<AppEngine>, path: String) -> CmdResult<NoteRelations> {
    state.with(|e| properties::relations_for(&e.db, &path))
}

/// Roll up a numeric `property_key` over the notes `path` relates to via
/// `relation_key` (count/sum/avg/min/max). Index-only.
#[tauri::command]
#[specta::specta]
pub fn note_rollup(
    state: State<AppEngine>,
    path: String,
    relation_key: String,
    property_key: String,
    op: RollupOp,
) -> CmdResult<RollupResult> {
    state.with(|e| properties::rollup_relation(&e.db, &path, &relation_key, &property_key, op))
}

/// Run a query-DSL string against the index and return matched notes (plus the
/// tasks of those notes when the query touches tasks), for the query view's
/// table / kanban / calendar renderers.
///
/// `async`: the index read runs on a blocking thread (off the UI), and a
/// `sort:similarity:"phrase"` clause additionally embeds the phrase and re-ranks
/// the results via the semantic index — that path errors loudly if no embedding
/// model is configured (see [`crate::ai::commands::similarity_scores`]).
#[tauri::command]
#[specta::specta]
pub async fn run_query(app: AppHandle, query: String) -> CmdResult<QueryResult> {
    // Parse once here so a similarity sort can be detected after execution.
    let parsed = index_query::parse(&query).map_err(CommandError::from)?;
    let run_app = app.clone();
    let run_parsed = parsed.clone();
    let mut result = tauri::async_runtime::spawn_blocking(move || {
        run_app
            .state::<AppEngine>()
            .with(|e| index_query::run(&e.db, &run_parsed))
    })
    .await
    .map_err(|e| CommandError::internal(format!("run_query task panicked: {e}")))??;

    // Stretch: semantic ordering. Only when explicitly requested.
    if let Some(phrase) = parsed.similarity_phrase() {
        let scores = crate::ai::commands::similarity_scores(&app, phrase).await?;
        rerank_by_similarity(&mut result, &scores);
    }
    Ok(result)
}

/// Reorder a result's notes by descending similarity score. Notes absent from
/// the semantic index keep their (stable) base order after the scored ones.
fn rerank_by_similarity(result: &mut QueryResult, scores: &HashMap<String, f32>) {
    result
        .notes
        .sort_by(|a, b| match (scores.get(&a.path), scores.get(&b.path)) {
            (Some(x), Some(y)) => y.partial_cmp(x).unwrap_or(std::cmp::Ordering::Equal),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        });
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
    let restored = state.with(|e| {
        let restored = trash::restore_note(&e.vault_path, &id)?;
        change::reindex_path(&e.db, &e.vault_path, &restored)?;
        Ok(restored)
    })?;
    mark_self_write(&restored);
    Ok(restored)
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
    track_note_write(state.with(|e| {
        novalis_core::notes::restore_version(&e.db, &e.vault_path, &e.data_dir, &path, &version_id)
    }))
}

// ── Preferences ────────────────────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub fn get_preferences(state: State<AppEngine>) -> CmdResult<Preferences> {
    state.with(|e| config::try_read_preferences(&e.vault_path))
}

#[tauri::command]
#[specta::specta]
pub fn set_preferences(state: State<AppEngine>, prefs: Preferences) -> CmdResult<()> {
    state.with(|e| config::write_preferences(&e.vault_path, &prefs))
}

// ── Git sync (P1: local auto-commit) ────────────────────────────────────────

/// Vault path snapshot for commands whose heavy work must run OUTSIDE the
/// engine lock — holding it would queue every other command (and the
/// watcher) behind the git work.
fn vault_path_snapshot(app: &AppHandle) -> CmdResult<PathBuf> {
    app.state::<AppEngine>().with(|e| Ok(e.vault_path.clone()))
}

/// Local repository status of the open vault. Works without a repo —
/// `initialized: false` means git sync isn't set up yet, not an error.
/// `async` + `spawn_blocking`: the status scan walks the working tree.
#[tauri::command]
#[specta::specta]
pub async fn git_status(app: AppHandle) -> CmdResult<GitStatus> {
    let vault = vault_path_snapshot(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        git::repo_status(&vault).map_err(CommandError::from)
    })
    .await
    .map_err(|e| CommandError::internal(format!("git_status task panicked: {e}")))?
}

/// Initialize the vault repository if needed and commit everything pending
/// with the configured author. Serves both the enable toggle (baseline
/// commit) and the manual "commit now" button; the background auto-committer
/// runs the same core path. `async` + `spawn_blocking` with the engine lock
/// released: the baseline commit hashes EVERY file in the vault — on the
/// main thread or under the lock it would freeze the app for its duration.
#[tauri::command]
#[specta::specta]
pub async fn git_commit_now(app: AppHandle) -> CmdResult<GitStatus> {
    let vault = vault_path_snapshot(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        git::ensure_repo(&vault)?;
        let prefs = config::try_read_preferences(&vault)?;
        git::commit_all(&vault, &prefs.git.author_name, &prefs.git.author_email)?;
        git::repo_status(&vault).map_err(CommandError::from)
    })
    .await
    .map_err(|e| CommandError::internal(format!("git_commit_now task panicked: {e}")))?
}

/// Prepare an agentic CLI run: resolve the open vault as the working directory
/// and take a best-effort git checkpoint so the session's edits land as a
/// clean, revertable commit boundary. Returns the vault path, or `None` when no
/// vault is open. Checkpoint failures (git not enabled, nothing to commit) are
/// ignored — they must never block the run. Called off the async runtime
/// (committing hashes files).
pub(crate) fn prepare_agentic_workdir(app: &AppHandle) -> Option<PathBuf> {
    let vault = vault_path_snapshot(app).ok()?;
    if git::ensure_repo(&vault).is_ok() {
        // Best-effort by contract: an unreadable config must not block the
        // run, but the checkpoint still deserves a real author if possible.
        let prefs = config::try_read_preferences(&vault).unwrap_or_else(|e| {
            log::warn!("agentic checkpoint: unreadable preferences, using defaults: {e}");
            Preferences::default()
        });
        let _ = git::commit_all(&vault, &prefs.git.author_name, &prefs.git.author_email);
    }
    Some(vault)
}

/// Commit everything pending and return the resulting HEAD commit id — a
/// checkpoint a later [`git_reset_hard`] can revert to (e.g. before/after an
/// agentic editing session). Returns `None` if the vault isn't a repo.
#[tauri::command]
#[specta::specta]
pub async fn git_checkpoint(app: AppHandle) -> CmdResult<Option<String>> {
    let vault = vault_path_snapshot(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if git::ensure_repo(&vault).is_err() {
            return Ok(None);
        }
        let prefs = config::try_read_preferences(&vault)?;
        let _ = git::commit_all(&vault, &prefs.git.author_name, &prefs.git.author_email)?;
        Ok(git::head_id(&vault))
    })
    .await
    .map_err(|e| CommandError::internal(format!("git_checkpoint task panicked: {e}")))?
}

/// Hard-reset the vault to `commit_id`, discarding all later changes — the
/// "undo this AI session" primitive. Irreversible by design; the caller
/// confirms first.
#[tauri::command]
#[specta::specta]
pub async fn git_reset_hard(app: AppHandle, commit_id: String) -> CmdResult<GitStatus> {
    let vault = vault_path_snapshot(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        git::reset_hard(&vault, &commit_id)?;
        git::repo_status(&vault).map_err(CommandError::from)
    })
    .await
    .map_err(|e| CommandError::internal(format!("git_reset_hard task panicked: {e}")))?
}

/// The vault's git access token from secret storage, if stored. Shared by
/// the sync command and the background auto-committer; the token itself
/// never crosses the IPC boundary to the frontend.
pub(crate) fn read_git_token(vault: &std::path::Path) -> Option<String> {
    crate::secrets::get(&format!("git:{}", vault.display()))
}

/// Set or clear the vault's `origin` remote. HTTPS only — this build
/// deliberately ships no ssh transport (engine-spike sign-off).
#[tauri::command]
#[specta::specta]
pub async fn git_set_remote(app: AppHandle, url: Option<String>) -> CmdResult<GitStatus> {
    let vault = vault_path_snapshot(&app)?;
    let url = url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    if let Some(u) = &url {
        if !u.starts_with("https://") {
            return Err(CoreError::BadRequest(
                "only https:// remotes are supported in this build".to_string(),
            )
            .into());
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        git::ensure_repo(&vault)?;
        git::set_remote(&vault, url.as_deref())?;
        git::repo_status(&vault).map_err(CommandError::from)
    })
    .await
    .map_err(|e| CommandError::internal(format!("git_set_remote task panicked: {e}")))?
}

/// Store (or, with an empty string, remove) the vault's git access token in
/// secret storage.
#[tauri::command]
#[specta::specta]
pub fn git_set_token(state: State<AppEngine>, token: String) -> CmdResult<()> {
    let account = state.with(|e| Ok(format!("git:{}", e.vault_path.display())))?;
    crate::secrets::set(&account, &token)
}

/// Whether a git access token is stored for this vault (the UI shows state
/// without ever receiving the token).
#[tauri::command]
#[specta::specta]
pub fn git_has_token(state: State<AppEngine>) -> CmdResult<bool> {
    state.with(|e| Ok(read_git_token(&e.vault_path).is_some()))
}

/// One manual sync cycle: fetch, then fast-forward, push, or auto-merge
/// (P2b — merge conflicts stop and are surfaced with their paths; never a
/// force-push). A file-changing checkout (pull or merge) is adopted the
/// same way for both: the watcher reindexes the checked-out paths and the
/// frontend reloads open notes via the external-change guard. `async` +
/// `spawn_blocking` off the engine lock: network plus checkout work.
#[tauri::command]
#[specta::specta]
pub async fn git_sync_now(app: AppHandle) -> CmdResult<GitSyncOutcome> {
    let vault = vault_path_snapshot(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let prefs = config::try_read_preferences(&vault)?;
        let token = read_git_token(&vault);
        git::sync(
            &vault,
            &prefs.git.author_name,
            &prefs.git.author_email,
            token.as_deref(),
        )
        .map_err(CommandError::from)
    })
    .await
    .map_err(|e| CommandError::internal(format!("git_sync_now task panicked: {e}")))?
}

/// The conflicted paths of a diverged merge with base/ours/theirs
/// materialized (P3a). Stateless: re-derived in memory on every call —
/// nothing is persisted between sync's `Conflicted` outcome and resolution,
/// so a restart just re-opens the resolver from this list. `async` +
/// `spawn_blocking` off the engine lock: the merge hashes blobs.
#[tauri::command]
#[specta::specta]
pub async fn git_merge_conflicts(app: AppHandle) -> CmdResult<Vec<GitConflict>> {
    let vault = vault_path_snapshot(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        git::merge_conflicts(&vault).map_err(CommandError::from)
    })
    .await
    .map_err(|e| CommandError::internal(format!("git_merge_conflicts task panicked: {e}")))?
}

/// Complete a conflicted merge with one resolution per conflicted path
/// (P3a): fetch, re-derive, apply, then 2-parent commit + checkout + push.
/// The checkout writes the merged files; the watcher reindexes them and the
/// frontend reloads open notes via the external-change path — the same
/// adoption as a pull. `async` + `spawn_blocking` off the engine lock:
/// network plus checkout work (mirrors `git_sync_now`).
#[tauri::command]
#[specta::specta]
pub async fn git_finalize_merge(app: AppHandle, resolutions: Vec<GitResolution>) -> CmdResult<()> {
    let vault = vault_path_snapshot(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let prefs = config::try_read_preferences(&vault)?;
        let token = read_git_token(&vault);
        git::finalize_merge(
            &vault,
            &prefs.git.author_name,
            &prefs.git.author_email,
            token.as_deref(),
            &resolutions,
        )
        .map_err(CommandError::from)
    })
    .await
    .map_err(|e| CommandError::internal(format!("git_finalize_merge task panicked: {e}")))?
}

// ── P2P sync (W4.4) ─────────────────────────────────────────────────────────
//
// A serverless, end-to-end-encrypted sync backend (iroh QUIC) offered as an
// opt-in ALTERNATIVE to the git sync above — the two never share state. See
// `crate::sync` and `novalis_core::sync`.

/// Snapshot of the P2P sync backend for the settings panel: whether it's set
/// up, this device's node id, the paired peers, and whether we're listening.
#[tauri::command]
#[specta::specta]
pub fn sync_status(app: AppHandle) -> CmdResult<SyncStatus> {
    crate::sync::service::status(&app)
}

/// Generate a shareable pairing ticket for a second device. Bootstraps the
/// device identity + vault key (kept in the keychain) and brings the endpoint
/// online. The returned string carries the vault key — treat it as a secret and
/// share it out-of-band.
#[tauri::command]
#[specta::specta]
pub async fn sync_generate_ticket(app: AppHandle) -> CmdResult<String> {
    crate::sync::service::generate_ticket(&app).await
}

/// Pair this vault with the device that produced `ticket`: store the shared
/// E2E key, record the peer, and come online.
#[tauri::command]
#[specta::specta]
pub async fn sync_join(app: AppHandle, ticket: String) -> CmdResult<()> {
    crate::sync::service::join(&app, ticket).await
}

/// Run one sync cycle against every paired peer: exchange manifests, transfer
/// the E2E-encrypted changed files, and surface divergences as conflict copies
/// (never a silent merge).
#[tauri::command]
#[specta::specta]
pub async fn sync_now(app: AppHandle) -> CmdResult<SyncOutcome> {
    crate::sync::service::sync_now(&app).await
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

/// Move a task (and its subtask block) to another note. The task id changes
/// after the move (id = hash of path + line); the frontend reloads.
#[tauri::command]
#[specta::specta]
pub fn move_task(state: State<AppEngine>, id: String, dest_note: String) -> CmdResult<()> {
    state.with(|e| task_svc::move_task(&e.db, &e.vault_path, &id, &dest_note))
}

#[tauri::command]
#[specta::specta]
pub fn quick_capture(state: State<AppEngine>, req: CaptureRequest) -> CmdResult<String> {
    let dest = state.with(|e| task_svc::quick_capture(&e.db, &e.vault_path, req))?;
    mark_self_write(&dest);
    Ok(dest)
}

// ── Export / templates / media ─────────────────────────────────────────────

/// Export a note to HTML or DOCX, prompting for a save location. Returns the
/// saved path, or `None` if the user cancelled.
///
/// `async` + `spawn_blocking`: `blocking_save_file` on the main thread would
/// deadlock — it asks the main thread's event loop to show the native panel
/// while blocking that same thread (see [`pick_vault_folder`]).
#[tauri::command]
#[specta::specta]
pub async fn export_note(
    app: AppHandle,
    path: String,
    format: String,
) -> CmdResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;

    tauri::async_runtime::spawn_blocking(move || {
        let (default_name, bytes) = app.state::<AppEngine>().with(|e| {
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
    })
    .await
    .map_err(|e| CommandError::internal(format!("export_note task panicked: {e}")))?
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

// ── PDF (native viewing + annotate + link, feature W4.2) ─────────────────────
//
// PDFs are rendered client-side by pdf.js off the asset protocol; their
// highlights live in a portable sidecar JSON beside each PDF (not the index/DB).

/// List the PDFs in the vault for the "Open PDF" picker (index-free filesystem walk).
#[tauri::command]
#[specta::specta]
pub fn list_pdfs(state: State<AppEngine>) -> CmdResult<Vec<pdf::PdfSummary>> {
    state.with(|e| Ok(pdf::list_pdfs(&e.vault_path)))
}

/// Read a PDF's sidecar annotations. A missing sidecar reads as empty.
#[tauri::command]
#[specta::specta]
pub fn read_pdf_annotations(
    state: State<AppEngine>,
    pdf_path: String,
) -> CmdResult<pdf::PdfAnnotations> {
    state.with(|e| pdf::read_annotations(&e.vault_path, &pdf_path))
}

/// Write a PDF's sidecar annotations (atomic; an empty set deletes the sidecar).
/// The sidecar is an app-initiated write — suppress the watcher echo.
#[tauri::command]
#[specta::specta]
pub fn write_pdf_annotations(
    state: State<AppEngine>,
    pdf_path: String,
    annotations: pdf::PdfAnnotations,
) -> CmdResult<()> {
    state.with(|e| pdf::write_annotations(&e.vault_path, &pdf_path, &annotations))?;
    mark_self_write(&pdf::sidecar_rel(&pdf_path));
    Ok(())
}

/// Append a highlight (quote + back-link) to a note, creating it when needed.
/// `target_note` is a vault-relative `.md` path; `None` files it into the PDF's
/// default `<stem> Highlights.md`. Returns the target note's path.
#[tauri::command]
#[specta::specta]
pub fn link_highlight_to_note(
    state: State<AppEngine>,
    pdf_path: String,
    highlight: pdf::PdfHighlight,
    target_note: Option<String>,
) -> CmdResult<String> {
    let path = state.with(|e| {
        pdf::link_highlight_to_note(
            &e.db,
            &e.vault_path,
            &e.data_dir,
            &pdf_path,
            &highlight,
            target_note.as_deref(),
        )
    })?;
    mark_self_write(&path);
    Ok(path)
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
    let ev = state.with(|e| calendar::create_event(&e.db, &e.vault_path, input))?;
    if let Some(p) = &ev.note_path {
        mark_self_write(p);
    }
    Ok(ev)
}

#[tauri::command]
#[specta::specta]
pub fn update_event(state: State<AppEngine>, input: EventInput) -> CmdResult<CalendarEvent> {
    let ev = state.with(|e| calendar::update_event(&e.db, &e.vault_path, input))?;
    if let Some(p) = &ev.note_path {
        mark_self_write(p);
    }
    Ok(ev)
}

#[tauri::command]
#[specta::specta]
pub fn delete_event(state: State<AppEngine>, note_path: String) -> CmdResult<()> {
    state.with(|e| calendar::delete_event(&e.db, &e.vault_path, &note_path))?;
    mark_self_write(&note_path);
    Ok(())
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

/// Materialize a meeting note for an own event (feature W1.3): append a dated,
/// backlinked entry to the day's journal note and a dated backlink to each
/// attendee note. `note_path` is the event's own-note (attendees come from its
/// frontmatter — the events index has no attendees column). `date` is the
/// occurrence the user acted on (`YYYY-MM-DD`). Idempotent per event+date.
#[tauri::command]
#[specta::specta]
pub fn add_meeting_note(
    state: State<AppEngine>,
    note_path: String,
    date: String,
) -> CmdResult<MeetingNoteResult> {
    let res = state.with(|e| {
        let mut event = calendar::read_event(&e.vault_path, &note_path)?;
        // Materialize against the clicked occurrence, not the event's base date.
        event.start = date;
        calendar::add_meeting_note(&e.db, &e.vault_path, &event)
    })?;
    // The journal + attendee notes are app-initiated writes; keep the watcher
    // from echoing them back as external edits.
    mark_self_write(&res.journal_path);
    for p in &res.attendee_notes {
        mark_self_write(p);
    }
    Ok(res)
}

// ── Review ───────────────────────────────────────────────────────────────────

/// Assemble the deterministic weekly-review digest for a window. `range_start`
/// (inclusive) and `range_end` (exclusive) are offset-carrying RFC 3339 instants
/// computed by the frontend in the user's local timezone — see
/// [`novalis_core::review`] for the window contract. Read-only; no LLM.
#[tauri::command]
#[specta::specta]
pub fn review_digest(
    state: State<AppEngine>,
    range_start: String,
    range_end: String,
) -> CmdResult<ReviewDigest> {
    state.with(|e| review::review_digest(&e.db, &range_start, &range_end))
}

#[tauri::command]
#[specta::specta]
pub fn list_calendar_sources(state: State<AppEngine>) -> CmdResult<Vec<CalendarSourceConfig>> {
    state.with(|e| calendar::source::try_list_sources(&e.vault_path))
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
///
/// `async` + `spawn_blocking`: the refresh does blocking network I/O (ICS
/// download or provider API round-trips), which would freeze the UI on the
/// main thread.
#[tauri::command]
#[specta::specta]
pub async fn refresh_calendar_source(app: AppHandle, id: String) -> CmdResult<u32> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppEngine>();
        let (kind, url) = state.with(|e| {
            calendar::source::try_list_sources(&e.vault_path)?
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
    })
    .await
    .map_err(|e| CommandError::internal(format!("refresh_calendar_source task panicked: {e}")))?
}

// ── OAuth (Google / Outlook) ──────────────────────────────────────────────

/// Run the interactive OAuth flow for `provider` ("google" | "outlook") and
/// register it as a calendar source.
///
/// `async` + `spawn_blocking`: the flow blocks on the loopback listener for up
/// to 180s waiting for the browser redirect, then does the token exchange over
/// the network — on the main thread that would freeze the UI for the whole
/// flow. The engine lock is only taken afterwards, to register the source.
#[tauri::command]
#[specta::specta]
pub async fn oauth_begin(app: AppHandle, provider: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::oauth::connect(&app, &provider)?;
        let name = match provider.as_str() {
            "google" => "Google Calendar",
            "outlook" => "Outlook Calendar",
            _ => "Calendar",
        };
        app.state::<AppEngine>().with(|e| {
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
    })
    .await
    .map_err(|e| CommandError::internal(format!("oauth_begin task panicked: {e}")))?
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
///
/// `async` + `spawn_blocking`: `blocking_pick_file` on the main thread would
/// deadlock — it asks the main thread's event loop to show the native panel
/// while blocking that same thread (see [`pick_vault_folder`]).
#[tauri::command]
#[specta::specta]
pub async fn import_ics(app: AppHandle) -> CmdResult<u32> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
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

        app.state::<AppEngine>().with(|e| {
            for ev in &events {
                let created = calendar::create_event(&e.db, &e.vault_path, event_to_input(ev))?;
                if let Some(p) = &created.note_path {
                    mark_self_write(p);
                }
            }
            Ok(events.len() as u32)
        })
    })
    .await
    .map_err(|e| CommandError::internal(format!("import_ics task panicked: {e}")))?
}

/// Export events in a range to an `.ics` file (save dialog). Returns saved path.
///
/// `async` + `spawn_blocking`: `blocking_save_file` on the main thread would
/// deadlock — it asks the main thread's event loop to show the native panel
/// while blocking that same thread (see [`pick_vault_folder`]).
#[tauri::command]
#[specta::specta]
pub async fn export_ics(
    app: AppHandle,
    range_start: String,
    range_end: String,
) -> CmdResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    tauri::async_runtime::spawn_blocking(move || {
        let ics = app.state::<AppEngine>().with(|e| {
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
    })
    .await
    .map_err(|e| CommandError::internal(format!("export_ics task panicked: {e}")))?
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
        attendees: e.attendees.clone(),
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

    #[cfg(desktop)] // is_recent_self_write is desktop-only (watcher consumer)
    #[test]
    fn self_write_suppression_tracks_marked_paths() {
        assert!(
            !is_recent_self_write("suppress-test/never-written.md"),
            "unmarked paths are not suppressed"
        );
        mark_self_write("suppress-test/note.md");
        assert!(
            is_recent_self_write("suppress-test/note.md"),
            "a just-marked path is suppressed"
        );
        assert!(
            !is_recent_self_write("suppress-test/other.md"),
            "suppression is per path"
        );
    }

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
