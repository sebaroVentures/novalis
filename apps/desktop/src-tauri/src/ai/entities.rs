//! Tauri commands for the local **entity graph** (W3.3).
//!
//! Extraction is **on-demand** (a command the user triggers), never per
//! keystroke: it costs provider tokens, exactly like `ai_build_embeddings`.
//! [`entities_extract_note`] runs the hidden `extract-entities` action against
//! one note, collecting the STRICT-JSON reply to completion (off the engine
//! lock, mirroring the streaming helpers in [`crate::ai`]), then resolves +
//! dedupes + upserts the entities and their mentions via
//! [`novalis_core::index::entities`]. The remaining commands are cheap,
//! index-only reads that back the entities panel and the "everything about X"
//! view.

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tokio::sync::Notify;

use novalis_core::ai::build_messages;
use novalis_core::index::{entities, vectors};
use novalis_core::models::{AiContext, AiProviderKind, EntityMention, EntitySummary};
use novalis_core::vault::frontmatter;

use crate::ai::{keychain, run_stream, AiRequest};
use crate::engine::{AppEngine, CommandError};

type CmdResult<T> = Result<T, CommandError>;

/// Resolve a chat connection into a ready [`AiRequest`] for `prompt`, validating
/// it is enabled and (for HTTP kinds) has a stored key. Mirrors the head of
/// `ai::commands::ai_run_action`; extraction never uses agentic/vault access.
fn build_ai_request(
    app: &AppHandle,
    connection_id: &str,
    prompt: novalis_core::ai::BuiltPrompt,
) -> CmdResult<AiRequest> {
    let conn = crate::settings::load_ai_connections(app)
        .into_iter()
        .find(|c| c.id == connection_id)
        .ok_or_else(|| CommandError {
            kind: "notFound".to_string(),
            message: "AI connection not found".to_string(),
        })?;
    if !conn.enabled {
        return Err(CommandError {
            kind: "badRequest".to_string(),
            message: "this AI connection is disabled".to_string(),
        });
    }
    let api_key = match conn.kind {
        AiProviderKind::Anthropic | AiProviderKind::OpenAiCompatible => {
            match keychain::read_key(&conn.id) {
                Some(k) => Some(k),
                None => {
                    return Err(CommandError {
                        kind: "aiAuth".to_string(),
                        message: "no API key is configured for this connection".to_string(),
                    })
                }
            }
        }
        // CLI providers authenticate via the user's own login — no key needed.
        AiProviderKind::ClaudeCli | AiProviderKind::CodexCli => None,
    };
    Ok(AiRequest {
        kind: conn.kind,
        base_url: conn.base_url,
        model: conn.model,
        api_key,
        prompt,
        agentic: false,
        workdir: None,
    })
}

/// Read one note's title (from the index) and body (from disk, frontmatter
/// stripped). The disk read happens OFF the engine lock (a cloud-synced vault can
/// hydrate an online-only file here), so this takes the vault path + title
/// snapshotted under the lock by the caller. `None` when the file is missing or
/// unreadable.
fn read_note_body(vault: &std::path::Path, path: &str) -> Option<String> {
    let content = std::fs::read_to_string(vault.join(path)).ok()?;
    let (_, body) = frontmatter::parse_frontmatter(&content);
    Some(body)
}

/// Run the `extract-entities` action to completion, returning the model's raw
/// reply. Collects the stream into a buffer (no panel/events) — the reply is
/// consumed programmatically. Off the engine lock. Not cancellable (on-demand,
/// short); a throwaway `Notify` is passed that never fires.
async fn collect_extraction(req: AiRequest) -> CmdResult<String> {
    let mut out = String::new();
    let notify = Arc::new(Notify::new());
    run_stream(req, notify, |delta| out.push_str(delta)).await?;
    Ok(out)
}

/// Extract entities from one note on demand: run the LLM action, parse + resolve
/// + dedupe the result, and upsert the entities and this note's mentions
/// (replacing any prior ones). Returns the note's resulting entity backlinks.
///
/// Long-running (awaits the whole model reply), like `ai_build_embeddings`; all
/// network + file IO stay off the engine lock, which is taken only for short
/// snapshot/upsert bursts.
#[tauri::command]
#[specta::specta]
pub async fn entities_extract_note(
    app: AppHandle,
    connection_id: String,
    path: String,
) -> CmdResult<Vec<EntitySummary>> {
    // Snapshot the title + vault path under a short lock; read the body off it.
    let (title, vault) = app.state::<AppEngine>().with(|e| {
        Ok((
            vectors::note_title(&e.db, &path)?.unwrap_or_default(),
            e.vault_path.clone(),
        ))
    })?;
    let path_read = path.clone();
    let body = tauri::async_runtime::spawn_blocking(move || read_note_body(&vault, &path_read))
        .await
        .map_err(|e| CommandError::internal(format!("note read failed: {e}")))?
        .ok_or_else(|| CommandError {
            kind: "notFound".to_string(),
            message: "the note could not be read".to_string(),
        })?;

    if body.trim().is_empty() {
        return Err(CommandError {
            kind: "badRequest".to_string(),
            message: "nothing to extract: the note is empty".to_string(),
        });
    }

    // Build the prompt (pure, in core) so an input error surfaces before the call.
    let ctx = AiContext {
        title: title.clone(),
        markdown: body.clone(),
        selection: None,
    };
    let prompt = build_messages("extract-entities", &ctx, None).map_err(CommandError::from)?;
    let req = build_ai_request(&app, &connection_id, prompt)?;

    // Run the model + parse OFF the engine lock.
    let raw = collect_extraction(req).await?;
    let extracted = entities::parse_entities(&raw).map_err(CommandError::from)?;

    // Upsert under a short lock, then return the note's entity backlinks.
    let out = app.state::<AppEngine>().with(|e| {
        entities::apply_note_extraction(&e.db, &path, &title, &body, &extracted)?;
        entities::prune_orphans(&e.db)?;
        entities::entities_in_note(&e.db, &path)
    })?;
    Ok(out)
}

/// Every entity with at least one live mention, most-mentioned first — the
/// entities-panel list. Index-only, no network.
#[tauri::command]
#[specta::specta]
pub fn entities_list(state: State<AppEngine>) -> CmdResult<Vec<EntitySummary>> {
    state.with(|e| entities::list_entities(&e.db))
}

/// The entities a note mentions (its entity backlinks). Index-only.
#[tauri::command]
#[specta::specta]
pub fn entities_for_note(state: State<AppEngine>, path: String) -> CmdResult<Vec<EntitySummary>> {
    state.with(|e| entities::entities_in_note(&e.db, &path))
}

/// All mentions of one entity across the vault — the "everything about X" view.
/// Index-only, no network.
#[tauri::command]
#[specta::specta]
pub fn entities_mentions(state: State<AppEngine>, entity_id: i64) -> CmdResult<Vec<EntityMention>> {
    state.with(|e| entities::mentions_for_entity(&e.db, entity_id))
}
