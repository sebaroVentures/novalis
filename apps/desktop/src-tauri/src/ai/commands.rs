//! Tauri commands for the AI subsystem. Connection configs live app-global in
//! [`crate::settings`]; API keys live in the OS keychain. Running an action
//! streams text deltas back as `ai-stream-*` events keyed by a `request_id`.

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager, State};

use novalis_core::ai::{action_views, build_messages};
use novalis_core::index::vectors;
use novalis_core::models::{
    AiActionView, AiConnectionConfig, AiConnectionView, AiEmbeddingConfig, AiProviderKind,
    AiRunRequest, AiTemplate, AiTemplateScope, EmbedStatus, RelatedNote,
};

use crate::ai::registry::AiRegistry;
use crate::ai::{catalog, cli, embeddings, keychain, run_stream, test_connection, AiRequest};
use crate::engine::{AppEngine, CommandError};
use crate::{AiEmbedProgress, AiStreamChunk, AiStreamDone, AiStreamError};

/// Progress-reporting chunk size for `ai_build_embeddings`: small enough that the
/// settings panel's progress bar moves smoothly, batched enough to be efficient.
const EMBED_BATCH: usize = 16;

type CmdResult<T> = Result<T, CommandError>;

/// The actions the editor can offer (metadata only).
#[tauri::command]
#[specta::specta]
pub fn ai_list_actions() -> Vec<AiActionView> {
    action_views()
}

/// All configured connections, each enriched with runtime status.
#[tauri::command]
#[specta::specta]
pub fn ai_list_connections(app: AppHandle) -> CmdResult<Vec<AiConnectionView>> {
    Ok(crate::settings::load_ai_connections(&app)
        .into_iter()
        .map(to_view)
        .collect())
}

/// Create or update a connection; returns the refreshed list.
#[tauri::command]
#[specta::specta]
pub fn ai_upsert_connection(
    app: AppHandle,
    config: AiConnectionConfig,
) -> CmdResult<Vec<AiConnectionView>> {
    crate::settings::upsert_ai_connection(&app, config);
    ai_list_connections(app)
}

/// Delete a connection and forget its key; returns the refreshed list.
#[tauri::command]
#[specta::specta]
pub fn ai_delete_connection(app: AppHandle, id: String) -> CmdResult<Vec<AiConnectionView>> {
    let _ = keychain::clear_key(&id);
    crate::settings::delete_ai_connection(&app, &id);
    ai_list_connections(app)
}

/// Store (or, with a blank string, clear) a connection's API key.
#[tauri::command]
#[specta::specta]
pub fn ai_set_api_key(id: String, key: String) -> CmdResult<()> {
    keychain::set_key(&id, &key)
}

/// Clear a connection's API key.
#[tauri::command]
#[specta::specta]
pub fn ai_clear_api_key(id: String) -> CmdResult<()> {
    keychain::clear_key(&id)
}

/// Whether a key is stored for `id` (the key itself never leaves the backend).
#[tauri::command]
#[specta::specta]
pub fn ai_has_api_key(id: String) -> CmdResult<bool> {
    Ok(keychain::has_key(&id))
}

/// Validate a connection's credentials without spending tokens.
#[tauri::command]
#[specta::specta]
pub async fn ai_test_connection(app: AppHandle, id: String) -> CmdResult<()> {
    let conn = find_connection(&app, &id)?;
    let key = keychain::read_key(&conn.id);
    test_connection(conn.kind, conn.base_url.as_deref(), key.as_deref()).await
}

/// Start running an action. Returns a `request_id`; text streams back as
/// `ai-stream-chunk` events, ending with `ai-stream-done` or `ai-stream-error`.
#[tauri::command]
#[specta::specta]
pub async fn ai_run_action(
    app: AppHandle,
    registry: State<'_, AiRegistry>,
    req: AiRunRequest,
) -> CmdResult<String> {
    let conn = find_connection(&app, &req.connection_id)?;
    if !conn.enabled {
        return Err(CommandError {
            kind: "badRequest".to_string(),
            message: "this AI connection is disabled".to_string(),
        });
    }

    // Build the prompt up front (pure, in core) so any input error surfaces
    // synchronously before we spawn the stream.
    let prompt = build_messages(&req.action_id, &req.context, req.user_input.as_deref())
        .map_err(CommandError::from)?;

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

    // Agentic vault access is CLI-only and opt-in. When on, resolve the vault as
    // the working dir and take a best-effort git checkpoint first, so the
    // session's edits land as a clean, revertable commit boundary. Committing
    // hashes files, so do it off the async runtime.
    let is_cli = matches!(
        conn.kind,
        AiProviderKind::ClaudeCli | AiProviderKind::CodexCli
    );
    let agentic = conn.agentic && is_cli;
    let workdir = if agentic {
        let app_prep = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::commands::prepare_agentic_workdir(&app_prep)
        })
        .await
        .ok()
        .flatten()
    } else {
        None
    };

    let ai_req = AiRequest {
        kind: conn.kind,
        base_url: conn.base_url,
        model: conn.model,
        api_key,
        prompt,
        agentic,
        workdir,
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let notify = registry.register(&request_id);

    let app_task = app.clone();
    let id_task = request_id.clone();
    tauri::async_runtime::spawn(async move {
        let emit_app = app_task.clone();
        let emit_id = id_task.clone();
        let on_text = move |delta: &str| {
            let _ = emit_app.emit(
                "ai-stream-chunk",
                AiStreamChunk {
                    request_id: emit_id.clone(),
                    delta: delta.to_string(),
                },
            );
        };

        let result = run_stream(ai_req, notify, on_text).await;
        app_task.state::<AiRegistry>().remove(&id_task);

        match result {
            Ok(usage) => {
                let _ = app_task.emit(
                    "ai-stream-done",
                    AiStreamDone {
                        request_id: id_task,
                        usage: Some(usage),
                    },
                );
            }
            Err(err) => {
                let _ = app_task.emit(
                    "ai-stream-error",
                    AiStreamError {
                        request_id: id_task,
                        message: err.message,
                    },
                );
            }
        }
    });

    Ok(request_id)
}

/// Cancel an in-flight run (no-op if it already finished).
#[tauri::command]
#[specta::specta]
pub fn ai_cancel(registry: State<AiRegistry>, request_id: String) -> CmdResult<()> {
    registry.cancel(&request_id);
    Ok(())
}

/// User-defined prompt templates: global (every vault) + the open vault's own.
#[tauri::command]
#[specta::specta]
pub fn ai_list_templates(app: AppHandle, state: State<AppEngine>) -> CmdResult<Vec<AiTemplate>> {
    collect_templates(&app, state.inner())
}

/// Create or overwrite a prompt template in the chosen scope; returns the list.
#[tauri::command]
#[specta::specta]
pub fn ai_save_template(
    app: AppHandle,
    state: State<AppEngine>,
    name: String,
    body: String,
    scope: AiTemplateScope,
) -> CmdResult<Vec<AiTemplate>> {
    let dir = template_dir(&app, state.inner(), scope)?;
    crate::ai::templates::save(&dir, &name, &body)?;
    collect_templates(&app, state.inner())
}

/// Delete a prompt template (by file id within its scope); returns the list.
#[tauri::command]
#[specta::specta]
pub fn ai_delete_template(
    app: AppHandle,
    state: State<AppEngine>,
    id: String,
    scope: AiTemplateScope,
) -> CmdResult<Vec<AiTemplate>> {
    let dir = template_dir(&app, state.inner(), scope)?;
    crate::ai::templates::delete(&dir, &id)?;
    collect_templates(&app, state.inner())
}

/// The global templates dir (app config dir); available without a vault.
fn global_templates_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|e| CommandError::internal(format!("cannot resolve app config dir: {e}")))?;
    Ok(base.join(crate::ai::templates::SUBDIR))
}

/// Resolve the directory for one scope (vault scope requires an open vault).
fn template_dir(app: &AppHandle, engine: &AppEngine, scope: AiTemplateScope) -> CmdResult<PathBuf> {
    match scope {
        AiTemplateScope::Global => global_templates_dir(app),
        AiTemplateScope::Vault => {
            let vault = engine.with(|e| Ok(e.vault_path.clone()))?;
            Ok(crate::ai::templates::vault_dir(&vault))
        }
    }
}

/// Merge global templates with the open vault's, sorted by name.
fn collect_templates(app: &AppHandle, engine: &AppEngine) -> CmdResult<Vec<AiTemplate>> {
    let mut out = Vec::new();
    if let Ok(dir) = global_templates_dir(app) {
        out.extend(crate::ai::templates::list(&dir, AiTemplateScope::Global)?);
    }
    // No vault open → just the global ones (don't error).
    if let Ok(vault) = engine.with(|e| Ok(e.vault_path.clone())) {
        let dir = crate::ai::templates::vault_dir(&vault);
        out.extend(crate::ai::templates::list(&dir, AiTemplateScope::Vault)?);
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

// ---------------------------------------------------------------------------
// Semantic index (embeddings): config, status, build, find-related.
// ---------------------------------------------------------------------------

fn embed_not_configured() -> CommandError {
    CommandError {
        kind: "aiEmbedNotConfigured".to_string(),
        message: "no embedding model is configured".to_string(),
    }
}

/// Resolve the embedding config into a usable `(connection, model)`. A missing,
/// disabled, non-OpenAI-compatible connection or empty model all map to
/// "not configured", so the UI shows the settings CTA rather than a hard error.
fn resolve_embedding(app: &AppHandle) -> CmdResult<(AiConnectionConfig, String)> {
    let cfg = crate::settings::load_ai_embedding(app).ok_or_else(embed_not_configured)?;
    if cfg.model.trim().is_empty() {
        return Err(embed_not_configured());
    }
    let conn = crate::settings::load_ai_connections(app)
        .into_iter()
        .find(|c| c.id == cfg.connection_id)
        .ok_or_else(embed_not_configured)?;
    if !conn.enabled || conn.kind != AiProviderKind::OpenAiCompatible {
        return Err(embed_not_configured());
    }
    Ok((conn, cfg.model))
}

/// The current embedding config (which connection + model), if any.
#[tauri::command]
#[specta::specta]
pub fn ai_embedding_config(app: AppHandle) -> CmdResult<Option<AiEmbeddingConfig>> {
    Ok(crate::settings::load_ai_embedding(&app))
}

/// Set the embedding config, or clear it when `connection_id` is blank.
#[tauri::command]
#[specta::specta]
pub fn ai_set_embedding_config(
    app: AppHandle,
    connection_id: String,
    model: String,
) -> CmdResult<()> {
    let cfg = if connection_id.trim().is_empty() {
        None
    } else {
        Some(AiEmbeddingConfig {
            connection_id,
            model: model.trim().to_string(),
        })
    };
    crate::settings::set_ai_embedding(&app, cfg);
    Ok(())
}

/// Coverage of the semantic index for the settings panel (sync; counts only —
/// no network, no per-note file reads).
#[tauri::command]
#[specta::specta]
pub fn ai_embed_status(app: AppHandle, state: State<AppEngine>) -> CmdResult<EmbedStatus> {
    let resolved = resolve_embedding(&app).ok();
    let model = resolved.as_ref().map(|(_, m)| m.clone());
    let total = state.with(|e| Ok(vectors::eligible_count(&e.db)? as u32))?;
    let embedded = match &model {
        Some(m) => state.with(|e| Ok(vectors::count_for_model(&e.db, m)? as u32))?,
        None => 0,
    };
    Ok(EmbedStatus {
        configured: resolved.is_some(),
        model,
        total,
        embedded,
    })
}

/// (Re)build the semantic index: embed every note new or changed since its last
/// vector. Emits `ai-embed-progress` between batches and returns final coverage.
/// Network + file IO stay OFF the engine lock (mirrors `git_sync_now`): the only
/// times the lock is taken are short `.with()` bursts to snapshot, prune, and
/// upsert one batch.
#[tauri::command]
#[specta::specta]
pub async fn ai_build_embeddings(app: AppHandle) -> CmdResult<EmbedStatus> {
    let (conn, model) = resolve_embedding(&app)?;
    let base_url = conn.base_url.clone();
    let api_key = keychain::read_key(&conn.id);

    // Snapshot the eligible notes + the per-model freshness oracle under a short
    // lock, then prune vectors orphaned by offline deletes/renames (safe now:
    // note_meta is fully populated).
    let (eligible, index, vault) = app.state::<AppEngine>().with(|e| {
        Ok((
            vectors::eligible_notes(&e.db)?,
            vectors::vector_index(&e.db, &model)?,
            e.vault_path.clone(),
        ))
    })?;
    app.state::<AppEngine>().with(|e| {
        vectors::prune_orphans(&e.db)?;
        Ok(())
    })?;

    // Read bodies + hash OFF the engine lock — a cloud-synced vault can hydrate
    // online-only files here, which must never happen while holding the mutex.
    let jobs = tauri::async_runtime::spawn_blocking(move || {
        vectors::collect_stale(&vault, &eligible, &index)
    })
    .await
    .map_err(|e| CommandError::internal(format!("embedding scan failed: {e}")))?;

    let total = jobs.len() as u32;
    let _ = app.emit("ai-embed-progress", AiEmbedProgress { done: 0, total });

    // Generous per-batch deadline: a build has no cancel affordance, so a
    // stalled embeddings endpoint must fail the batch rather than hang forever.
    let client = crate::ai::bounded_client(std::time::Duration::from_secs(120));
    let mut done = 0u32;
    for batch in jobs.chunks(EMBED_BATCH) {
        let inputs: Vec<String> = batch.iter().map(|j| j.text.clone()).collect();
        let vecs = embeddings::embed_batch(
            &client,
            base_url.as_deref(),
            api_key.as_deref(),
            &model,
            &inputs,
        )
        .await?;

        app.state::<AppEngine>().with(|e| {
            for (job, vec) in batch.iter().zip(vecs.iter()) {
                vectors::upsert_vector(&e.db, &job.path, &job.content_hash, &model, vec)?;
            }
            Ok(())
        })?;

        done += batch.len() as u32;
        let _ = app.emit("ai-embed-progress", AiEmbedProgress { done, total });
    }

    ai_embed_status(app.clone(), app.state::<AppEngine>())
}

/// Notes semantically nearest to `path`, from stored embeddings only (local, no
/// network). Returns `aiEmbedStale` when the note isn't indexed for the current
/// model yet — or was edited since it was embedded — so the panel can nudge the
/// user to build the index instead of silently serving neighbors of old text.
#[tauri::command]
#[specta::specta]
pub fn ai_find_related(
    app: AppHandle,
    state: State<AppEngine>,
    path: String,
    limit: u32,
) -> CmdResult<Vec<RelatedNote>> {
    let (_, model) = resolve_embedding(&app)?;

    fn stale() -> CommandError {
        CommandError {
            kind: "aiEmbedStale".to_string(),
            message: "this note isn't in the semantic index yet".to_string(),
        }
    }

    // Take the engine lock only to snapshot: the anchor row + its title, the
    // raw candidate rows, and the vault path. The per-row f32 decoding, the
    // cosine scan, and the freshness file read all happen off the lock.
    let (stored, title, rows, vault) = state.with(|e| {
        Ok((
            vectors::get_vector(&e.db, &path)?,
            vectors::note_title(&e.db, &path)?,
            vectors::candidate_rows_for_model(&e.db, &model)?,
            e.vault_path.clone(),
        ))
    })?;

    let stored = match stored {
        Some(s) if s.model == model => s,
        _ => return Err(stale()),
    };

    // Freshness: hash what a build would embed right now (same pipeline as
    // collect_stale) and compare with the stored hash. A note that is missing,
    // empty, or a cloud placeholder can't match either — it needs a rebuild.
    let current = title
        .as_deref()
        .and_then(|t| vectors::read_embed_text(&vault, &path, t))
        .map(|full| vectors::content_hash(&full));
    if current.as_deref() != Some(stored.content_hash.as_str()) {
        return Err(stale());
    }

    let cands = vectors::decode_candidates(rows);
    Ok(vectors::nearest(&cands, &stored.vec, limit as usize, &path)
        .into_iter()
        .map(|h| RelatedNote {
            path: h.path,
            title: h.title,
            score: h.score as f64,
        })
        .collect())
}

fn find_connection(app: &AppHandle, id: &str) -> CmdResult<AiConnectionConfig> {
    crate::settings::load_ai_connections(app)
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| CommandError {
            kind: "notFound".to_string(),
            message: "AI connection not found".to_string(),
        })
}

fn to_view(c: AiConnectionConfig) -> AiConnectionView {
    let (configured, available) = match c.kind {
        // HTTP providers are reachable; "configured" means a key is stored.
        AiProviderKind::Anthropic | AiProviderKind::OpenAiCompatible => {
            (keychain::has_key(&c.id), true)
        }
        // CLI providers need no key: "configured" == "available" == binary found.
        AiProviderKind::ClaudeCli | AiProviderKind::CodexCli => {
            let found = cli::is_available(c.kind, c.base_url.as_deref());
            (found, found)
        }
    };
    AiConnectionView {
        models: catalog::models_for(c.kind),
        configured,
        available,
        id: c.id,
        kind: c.kind,
        label: c.label,
        base_url: c.base_url,
        model: c.model,
        enabled: c.enabled,
        // Agentic vault access is meaningful only for CLI kinds.
        agentic: c.agentic
            && matches!(c.kind, AiProviderKind::ClaudeCli | AiProviderKind::CodexCli),
    }
}
