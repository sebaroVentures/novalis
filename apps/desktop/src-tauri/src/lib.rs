//! Thin Tauri v2 shell for Novalis.
//!
//! This binary owns no business logic: it wires [`novalis_core`] functions to
//! the frontend as typed Tauri **commands** and pushes **events**. The
//! command/event surface is declared once in [`specta_builder`] and is the
//! single source of truth for the auto-generated TypeScript bindings
//! (`frontend/src/ipc/bindings.ts`), so Rust and TS can never drift.

use novalis_core::AppInfo;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::{collect_commands, collect_events, Builder};

/// Returns app/build info from the core. M0 smoke test for the IPC pipeline.
#[tauri::command]
#[specta::specta]
fn app_info() -> AppInfo {
    novalis_core::app_info()
}

/// Emitted when the vault finishes (re)indexing. Placeholder proving the typed
/// event channel; real vault/calendar events land in M1/M4.
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct ReindexedEvent;

/// The command + event surface. Shared by [`run`] and the binding generator.
fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![app_info])
        .events(collect_events![ReindexedEvent])
}

/// Export the TypeScript IPC bindings beside the frontend source. The path is
/// resolved from this crate's directory so it is independent of the working
/// directory (works from `cargo run`, `cargo test`, or `tauri dev`).
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
    // Keep bindings in sync automatically during development.
    #[cfg(debug_assertions)]
    export_bindings();

    let builder = specta_builder();

    tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Novalis");
}
