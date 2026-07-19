//! Desktop file watcher. Watches the open vault for external `.md` changes
//! (e.g. OneDrive sync), keeps the index in sync via [`change::reindex_path`],
//! and emits typed events so the UI can refresh.
//!
//! A global generation counter ties a watcher to the vault that started it:
//! opening another vault bumps the counter and the stale watcher exits.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use notify_debouncer_mini::new_debouncer;
use tauri::{AppHandle, Emitter, Manager};

use novalis_core::change;

use crate::engine::AppEngine;
use crate::{ConflictDetected, NoteChanged, NoteDeleted};

/// Incremented on every vault open; a watcher runs only while it matches.
pub static WATCH_GEN: AtomicU64 = AtomicU64::new(0);

/// Spawn a watcher thread for `vault`, tagged with `generation`.
pub fn start(app: AppHandle, vault: PathBuf, generation: u64) {
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut debouncer = match new_debouncer(Duration::from_millis(300), tx) {
            Ok(d) => d,
            Err(e) => {
                log::error!("watcher init failed: {e}");
                return;
            }
        };

        if let Err(e) = debouncer
            .watcher()
            .watch(&vault, notify::RecursiveMode::Recursive)
        {
            log::error!("failed to watch {}: {e}", vault.display());
            return;
        }
        log::info!("watching {}", vault.display());

        let conflict_re =
            regex::Regex::new(r"(?:\s+\(\d+\)\.md$)|(?:-DESKTOP-[A-Z0-9]+\.md$)").unwrap();

        loop {
            if WATCH_GEN.load(Ordering::SeqCst) != generation {
                break;
            }
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(Ok(events)) => {
                    for ev in events {
                        process(&app, &vault, &ev.path, &conflict_re);
                    }
                }
                Ok(Err(e)) => log::warn!("watch error: {e:?}"),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        log::info!("watcher for {} stopped", vault.display());
    });
}

fn process(app: &AppHandle, vault: &Path, path: &Path, conflict_re: &regex::Regex) {
    if path.extension().and_then(|e| e.to_str()) != Some("md") {
        return;
    }
    let Ok(rel) = path.strip_prefix(vault) else {
        return;
    };
    // Skip hidden files/folders (incl. `.novalis`).
    if rel
        .components()
        .any(|c| c.as_os_str().to_string_lossy().starts_with('.'))
    {
        return;
    }
    let filename = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    if filename.starts_with('~') || filename.ends_with('~') {
        return;
    }
    let rel_str = rel.to_string_lossy().replace('\\', "/");

    // App-initiated writes already updated the index in the command that made
    // them; skip the redundant reindex and don't echo events back at the UI.
    if crate::commands::is_recent_self_write(&rel_str) {
        return;
    }

    // Keep the index current via the same path as a manual rescan. Feature
    // flags are resolved BEFORE taking the lock (a config.json read is file
    // IO). Poison recovery matches [`AppEngine::with`] — a poisoned lock must
    // not stop the watcher from indexing forever.
    let opts = novalis_core::index::search::IndexOptions::for_vault(vault);
    let state = app.state::<AppEngine>();
    {
        let guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(engine) = guard.as_ref() {
            let _ = change::reindex_path_with_opts(&engine.db, &engine.vault_path, &rel_str, opts);
        }
    }

    if conflict_re.is_match(&filename) {
        let _ = app.emit(
            "conflict-detected",
            ConflictDetected {
                path: rel_str.clone(),
            },
        );
    }
    if path.exists() {
        let _ = app.emit("note-changed", NoteChanged { path: rel_str });
    } else {
        let _ = app.emit("note-deleted", NoteDeleted { path: rel_str });
    }
}
