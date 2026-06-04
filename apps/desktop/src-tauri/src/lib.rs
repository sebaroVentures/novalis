//! Thin Tauri v2 shell for Novalis.
//!
//! No business logic lives here: it wires [`novalis_core`] to the frontend as
//! typed Tauri **commands** and **events**. The command/event surface is
//! declared once in [`specta_builder`] and is the single source of truth for
//! the auto-generated TypeScript bindings (`frontend/src/ipc/bindings.ts`).

mod commands;
mod engine;
mod oauth;
mod settings;
#[cfg(desktop)]
mod watcher;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::{collect_commands, collect_events, Builder};

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

/// The command + event surface. Shared by [`run`] and the binding generator.
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            commands::app_info,
            commands::open_vault,
            commands::close_vault,
            commands::current_vault,
            commands::pick_vault_folder,
            commands::list_notes,
            commands::get_note,
            commands::create_note,
            commands::update_note,
            commands::update_note_meta,
            commands::move_note,
            commands::duplicate_note,
            commands::delete_note,
            commands::resolve_or_create_wiki_link,
            commands::get_folder_tree,
            commands::create_folder,
            commands::delete_folder,
            commands::delete_folder_recursive,
            commands::move_folder,
            commands::search,
            commands::quick_search,
            commands::backlinks,
            commands::unlinked_mentions,
            commands::link_mention,
            commands::note_graph,
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
            commands::restore_version,
            commands::get_preferences,
            commands::set_preferences,
            commands::list_tasks,
            commands::create_task,
            commands::toggle_task,
            commands::set_task_status,
            commands::update_task,
            commands::delete_task,
            commands::quick_capture,
            commands::export_note,
            commands::list_templates,
            commands::create_template,
            commands::delete_template,
            commands::save_pasted_image,
            commands::list_events,
            commands::create_event,
            commands::update_event,
            commands::delete_event,
            commands::get_agenda,
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
        ])
        .events(collect_events![
            ReindexedEvent,
            NoteChanged,
            NoteDeleted,
            ConflictDetected
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
    #[cfg(debug_assertions)]
    export_bindings();

    let builder = specta_builder();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(engine::AppEngine::default())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);

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
        .run(tauri::generate_context!())
        .expect("error while running Novalis");
}
