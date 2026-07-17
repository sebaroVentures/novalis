//! Thin Tauri v2 shell for Novalis.
//!
//! No business logic lives here: it wires [`novalis_core`] to the frontend as
//! typed Tauri **commands** and **events**. The command/event surface is
//! declared once in [`specta_builder`] and is the single source of truth for
//! the auto-generated TypeScript bindings (`frontend/src/ipc/bindings.ts`).

mod ai;
#[cfg(desktop)]
mod autocommit;
mod bg;
mod commands;
mod engine;
#[cfg(mobile)]
mod mobile;
mod oauth;
mod secrets;
mod settings;
mod sync;
mod voice;
#[cfg(desktop)]
mod watcher;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::{collect_commands, collect_events, Builder};

use novalis_core::models::Usage;

/// Emitted when the vault finishes (re)indexing, so the UI can refresh fully.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct ReindexedEvent;

/// A note was created or modified on disk (path is vault-relative).
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct NoteChanged {
    pub path: String,
}

/// A note was removed from disk.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct NoteDeleted {
    pub path: String,
}

/// A sync-conflict file was detected.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct ConflictDetected {
    pub path: String,
}

/// A background sync cycle hit merge conflicts (P3b). Emitted by the
/// auto-committer only when the conflict set CHANGES — a persisting identical
/// conflict is re-detected every interval but must not re-open the resolver
/// on every tick. `paths` are vault-relative, sorted.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictDetected {
    pub paths: Vec<String>,
}

/// A chunk of AI-generated text for an in-flight request (keyed by `requestId`).
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamChunk {
    pub request_id: String,
    pub delta: String,
}

/// An AI request finished; carries token usage when the provider reported it.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamDone {
    pub request_id: String,
    pub usage: Option<Usage>,
}

/// An AI request failed (transport, auth, or a provider error mid-stream).
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AiStreamError {
    pub request_id: String,
    pub message: String,
}

/// Progress of a semantic-index build (`ai_build_embeddings`): notes embedded so
/// far out of the total that need (re)embedding. Emitted between batches.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
pub struct AiEmbedProgress {
    pub done: u32,
    pub total: u32,
}

/// The command + event surface. Shared by [`run`] and the binding generator.
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::app_info,
            commands::platform_info,
            commands::default_vault_path,
            commands::open_vault,
            commands::close_vault,
            commands::current_vault,
            commands::pick_vault_folder,
            commands::validate_vault,
            commands::list_recent_vaults,
            commands::remove_recent_vault,
            commands::list_notes,
            commands::get_note,
            commands::resolve_embed,
            commands::create_note,
            commands::update_note,
            commands::update_note_meta,
            commands::set_property,
            commands::remove_property,
            commands::rename_property,
            commands::move_note,
            commands::duplicate_note,
            commands::delete_note,
            commands::list_canvases,
            commands::read_canvas,
            commands::write_canvas,
            commands::create_canvas,
            commands::delete_canvas,
            commands::reveal_in_file_manager,
            commands::resolve_or_create_wiki_link,
            commands::get_folder_tree,
            commands::create_folder,
            commands::delete_folder,
            commands::delete_folder_recursive,
            commands::move_folder,
            commands::search,
            commands::quick_search,
            commands::list_tags,
            commands::backlinks,
            commands::unlinked_mentions,
            commands::link_mention,
            commands::note_graph,
            commands::full_graph,
            commands::search_blocks,
            commands::resolve_block,
            commands::block_backlinks,
            commands::note_properties,
            commands::note_relations,
            commands::note_rollup,
            commands::run_query,
            commands::get_vault_info,
            commands::get_vault_stats,
            commands::reindex_vault,
            commands::rescan_vault,
            commands::list_conflicts,
            commands::conflict_diff,
            commands::resolve_conflict,
            commands::list_trash,
            commands::restore_trash,
            commands::delete_trash_item,
            commands::empty_trash,
            commands::list_versions,
            commands::read_version,
            commands::diff_version,
            commands::restore_version,
            commands::get_preferences,
            commands::set_preferences,
            commands::git_status,
            commands::git_commit_now,
            commands::git_checkpoint,
            commands::git_reset_hard,
            commands::git_set_remote,
            commands::git_set_token,
            commands::git_has_token,
            commands::git_sync_now,
            commands::git_merge_conflicts,
            commands::git_finalize_merge,
            commands::sync_status,
            commands::sync_generate_ticket,
            commands::sync_join,
            commands::sync_now,
            commands::list_tasks,
            commands::create_task,
            commands::toggle_task,
            commands::set_task_status,
            commands::update_task,
            commands::delete_task,
            commands::move_task,
            commands::quick_capture,
            commands::export_note,
            commands::list_templates,
            commands::create_template,
            commands::delete_template,
            commands::render_template,
            commands::save_pasted_image,
            commands::list_pdfs,
            commands::read_pdf_annotations,
            commands::write_pdf_annotations,
            commands::link_highlight_to_note,
            commands::list_events,
            commands::create_event,
            commands::update_event,
            commands::delete_event,
            commands::get_agenda,
            commands::add_meeting_note,
            commands::review_digest,
            commands::list_calendar_sources,
            commands::add_calendar_source,
            commands::remove_calendar_source,
            commands::refresh_calendar_source,
            commands::import_ics,
            commands::export_ics,
            commands::oauth_begin,
            commands::oauth_status,
            commands::oauth_disconnect,
            commands::list_plugins,
            commands::set_plugin_enabled,
            commands::read_plugin_source,
            ai::commands::ai_list_actions,
            ai::commands::ai_list_connections,
            ai::commands::ai_upsert_connection,
            ai::commands::ai_delete_connection,
            ai::commands::ai_set_api_key,
            ai::commands::ai_clear_api_key,
            ai::commands::ai_has_api_key,
            ai::commands::ai_test_connection,
            ai::commands::ai_run_action,
            ai::commands::ai_cancel,
            ai::commands::ai_list_templates,
            ai::commands::ai_save_template,
            ai::commands::ai_delete_template,
            ai::commands::ai_embedding_config,
            ai::commands::ai_set_embedding_config,
            ai::commands::ai_embed_status,
            ai::commands::ai_build_embeddings,
            ai::commands::ai_find_related,
            ai::commands::ai_rag_answer,
            ai::entities::entities_extract_note,
            ai::entities::entities_list,
            ai::entities::entities_for_note,
            ai::entities::entities_mentions,
            voice::commands::voice_capabilities,
            voice::commands::voice_start_recording,
            voice::commands::voice_stop_recording,
            voice::commands::voice_cancel_recording,
            voice::commands::voice_delete_recording,
            voice::commands::voice_transcribe,
        ])
        .events(collect_events![
            ReindexedEvent,
            NoteChanged,
            NoteDeleted,
            ConflictDetected,
            GitConflictDetected,
            AiStreamChunk,
            AiStreamDone,
            AiStreamError,
            AiEmbedProgress
        ])
        // Counts/sizes are small; render Rust integer types as TS `number`.
        .dangerously_cast_bigints_to_number()
}

/// Export the TypeScript IPC bindings beside the frontend source.
pub fn export_bindings() {
    let out =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../frontend/src/ipc/bindings.ts");
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).expect("create frontend ipc directory");
    }
    specta_builder()
        .export(specta_typescript::Typescript::default(), &out)
        .expect("export TypeScript bindings");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Desktop-only: on a device the CARGO_MANIFEST_DIR-relative frontend path
    // doesn't exist and the filesystem is read-only — a debug APK panics here.
    #[cfg(all(debug_assertions, desktop))]
    export_bindings();

    let builder = specta_builder();

    tauri::Builder::default()
        // Without a logger every `log::warn!` in core and the shell is a
        // no-op — and a bundled app's stderr goes nowhere, so log to the OS
        // log dir as well as stdout (visible under `pnpm dev`).
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(engine::AppEngine::default())
        .manage(ai::registry::AiRegistry::default())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);

            // Cache the loaded on-device embedder in managed state so a RAG
            // question / similarity sort doesn't reload ~130 MB of ONNX per
            // request (desktop only — no bundled ONNX Runtime on Android).
            #[cfg(not(target_os = "android"))]
            {
                use tauri::Manager;
                app.manage(ai::embed_local::LocalEmbedderCache::default());
            }

            // Android's file-backed secret store needs the app-private data
            // dir, which only the path resolver knows (see secrets.rs).
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                match app.path().app_data_dir() {
                    Ok(dir) => secrets::init_store(dir),
                    Err(e) => log::error!("secret store: no app data dir: {e}"),
                }
            }

            // Mobile has no file watcher and no background sync thread — the
            // Activity lifecycle drives rescan+pull (onResume) and commit+push
            // (onPause) instead. Desktop uses the watcher + autocommit thread.
            #[cfg(mobile)]
            {
                use tauri::{Manager, WindowEvent};
                if let Some(win) = app.get_webview_window("main") {
                    let handle = app.handle().clone();
                    win.on_window_event(move |event| match event {
                        WindowEvent::Resumed => mobile::on_resume(&handle),
                        WindowEvent::Suspended => mobile::on_suspend(&handle),
                        _ => {}
                    });
                }
            }

            // Sweep stale voice takes (crashed runs, pre-cleanup versions) out
            // of app-data/voice. Runs synchronously in setup — before the
            // webview can invoke any command — so it cannot race an active
            // recording; plaintext meeting audio must not accumulate on disk.
            #[cfg(desktop)]
            voice::commands::sweep_stale_recordings(app.handle());

            // Reopen the last vault in the background so the window appears fast.
            let handle = app.handle().clone();
            if let Some(last) = settings::load_last_vault(&handle) {
                std::thread::spawn(move || {
                    if let Err(e) = commands::open_vault_impl(&handle, &last) {
                        log::warn!("failed to reopen last vault: {e:?}");
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Novalis")
        .run(|app, event| {
            // Commit-on-quit (P3b) hooks `RunEvent::Exit`, NOT `ExitRequested`:
            // on macOS the default menu's Quit item (⌘Q) sends the native
            // `terminate:` selector, which reaches tauri only as
            // `applicationWillTerminate` → `RunEvent::Exit` — `ExitRequested`
            // never fires on that path (verified against tauri-runtime-wry
            // 2.11 / tao 0.35). Closing the last window fires `ExitRequested`
            // first and `Exit` after, so `Exit` covers both paths exactly
            // once. The handler blocks the (exiting) event loop for at most
            // the local commit plus a hard ~5 s sync timeout.
            #[cfg(desktop)]
            if let tauri::RunEvent::Exit = event {
                autocommit::commit_on_quit(app);
            }
            // Mobile lifecycle (resume-rescan / pause-sync) lands with the
            // Android alpha (MOBILE.md Phase 1).
            #[cfg(mobile)]
            let _ = (app, event);
        });
}
