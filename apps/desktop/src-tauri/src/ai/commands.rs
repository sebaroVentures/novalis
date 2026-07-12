//! Tauri commands for the AI subsystem. Connection configs live app-global in
//! [`crate::settings`]; API keys live in the OS keychain. Running an action
//! streams text deltas back as `ai-stream-*` events keyed by a `request_id`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

use novalis_core::ai::{action_views, build_messages, rag};
use novalis_core::index::{search as index_search, vectors};
use novalis_core::models::{
    AiActionView, AiConnectionConfig, AiConnectionView, AiEmbeddingConfig, AiProviderKind,
    AiRunRequest, AiTemplate, AiTemplateScope, EmbedStatus, RagCitation, RagResponse, RelatedNote,
    LOCAL_EMBEDDING_CONNECTION_ID, LOCAL_EMBEDDING_MODEL,
};

// The bundled on-device embedder is desktop-only (see `crate::ai::embed_local`).
#[cfg(not(target_os = "android"))]
use crate::ai::embed_local;

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

/// A resolved embedding backend: either a remote OpenAI-compatible connection or
/// the bundled on-device model. Both carry the `note_vectors.model` id they
/// write under (so local and remote vectors coexist under distinct models).
enum ResolvedEmbedder {
    /// Remote embeddings via an enabled OpenAI-compatible connection.
    Http {
        conn: AiConnectionConfig,
        model: String,
    },
    /// The bundled, on-device model (desktop only).
    Local { model: String },
}

impl ResolvedEmbedder {
    /// The `note_vectors.model` id for this backend.
    fn model(&self) -> &str {
        match self {
            Self::Http { model, .. } | Self::Local { model } => model,
        }
    }
}

/// Resolve the embedding config into a usable backend. The reserved
/// [`LOCAL_EMBEDDING_CONNECTION_ID`] selects the bundled on-device model;
/// otherwise a missing/empty config, or a connection that is disabled, missing,
/// non-OpenAI-compatible, or has an empty model, all map to "not configured" so
/// the UI shows the settings CTA rather than a hard error.
fn resolve_embedding(app: &AppHandle) -> CmdResult<ResolvedEmbedder> {
    let cfg = crate::settings::load_ai_embedding(app).ok_or_else(embed_not_configured)?;
    if cfg.connection_id == LOCAL_EMBEDDING_CONNECTION_ID {
        return Ok(ResolvedEmbedder::Local {
            model: LOCAL_EMBEDDING_MODEL.to_string(),
        });
    }
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
    Ok(ResolvedEmbedder::Http {
        conn,
        model: cfg.model,
    })
}

/// A ready-to-run embedding backend: the HTTP client + creds for a remote
/// connection, or the loaded on-device model. Built once per index build via
/// [`build_embedder`] and reused across batches.
enum Embedder {
    Http {
        client: reqwest::Client,
        base_url: Option<String>,
        api_key: Option<String>,
    },
    #[cfg(not(target_os = "android"))]
    Local(embed_local::LocalEmbedder),
}

impl Embedder {
    /// Embed one batch into a vector per input. HTTP hits the endpoint; local
    /// runs the model on a blocking thread (`fastembed` is CPU-bound and takes
    /// `&mut self`).
    async fn embed_batch(&self, model: &str, inputs: &[String]) -> CmdResult<Vec<Vec<f32>>> {
        match self {
            Embedder::Http {
                client,
                base_url,
                api_key,
            } => {
                embeddings::embed_batch(
                    client,
                    base_url.as_deref(),
                    api_key.as_deref(),
                    model,
                    inputs,
                )
                .await
            }
            #[cfg(not(target_os = "android"))]
            Embedder::Local(local) => {
                let local = local.clone();
                let inputs = inputs.to_vec();
                tauri::async_runtime::spawn_blocking(move || local.embed(&inputs))
                    .await
                    .map_err(|e| {
                        CommandError::internal(format!("local embedding task failed: {e}"))
                    })?
            }
        }
    }
}

/// Construct the embedder for a resolved backend. HTTP is cheap; local loads
/// (and on first use downloads + caches) the model off the async runtime.
async fn build_embedder(app: &AppHandle, resolved: &ResolvedEmbedder) -> CmdResult<Embedder> {
    match resolved {
        ResolvedEmbedder::Http { conn, .. } => Ok(Embedder::Http {
            // Generous per-batch deadline: a build has no cancel affordance, so a
            // stalled embeddings endpoint must fail the batch rather than hang.
            client: crate::ai::bounded_client(std::time::Duration::from_secs(120)),
            base_url: conn.base_url.clone(),
            api_key: keychain::read_key(&conn.id),
        }),
        ResolvedEmbedder::Local { .. } => build_local_embedder(app).await,
    }
}

/// Load the bundled model (weights cached under the app-data dir), off the
/// async runtime.
#[cfg(not(target_os = "android"))]
async fn build_local_embedder(app: &AppHandle) -> CmdResult<Embedder> {
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| CommandError::internal(format!("cannot resolve app data dir: {e}")))?
        .join("embeddings");
    let local = tauri::async_runtime::spawn_blocking(move || embed_local::load(&cache_dir))
        .await
        .map_err(|e| CommandError::internal(format!("model load task failed: {e}")))??;
    Ok(Embedder::Local(local))
}

/// Android has no prebuilt ONNX Runtime, so a "local" config can't run there.
#[cfg(target_os = "android")]
async fn build_local_embedder(_app: &AppHandle) -> CmdResult<Embedder> {
    Err(CommandError {
        kind: "aiEmbedLocal".to_string(),
        message: "the bundled on-device embedding model isn't available on this platform"
            .to_string(),
    })
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
    } else if connection_id == LOCAL_EMBEDDING_CONNECTION_ID {
        // The bundled model's id is fixed; ignore whatever model the UI sent.
        Some(AiEmbeddingConfig {
            connection_id,
            model: LOCAL_EMBEDDING_MODEL.to_string(),
        })
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
    let model = resolved.as_ref().map(|r| r.model().to_string());
    let total = state.with(|e| Ok(vectors::eligible_count(&e.db)? as u32))?;
    let embedded = match &model {
        Some(m) => state.with(|e| Ok(vectors::count_notes_for_model(&e.db, m)? as u32))?,
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
    let resolved = resolve_embedding(&app)?;
    let model = resolved.model().to_string();

    // Snapshot the eligible notes + the per-model freshness oracle under a short
    // lock, then prune vectors orphaned by offline deletes/renames (safe now:
    // note_meta is fully populated).
    let (eligible, index, vault) = app.state::<AppEngine>().with(|e| {
        Ok((
            vectors::eligible_notes(&e.db)?,
            vectors::chunk_hashes_for_model(&e.db, &model)?,
            e.vault_path.clone(),
        ))
    })?;
    app.state::<AppEngine>().with(|e| {
        vectors::prune_orphans(&e.db)?;
        Ok(())
    })?;

    // Read bodies + hash + chunk OFF the engine lock — a cloud-synced vault can
    // hydrate online-only files here, which must never happen while holding the
    // mutex. Each job carries the note's chunks (one embed input each).
    let jobs = tauri::async_runtime::spawn_blocking(move || {
        vectors::collect_stale(&vault, &eligible, &index)
    })
    .await
    .map_err(|e| CommandError::internal(format!("embedding scan failed: {e}")))?;

    // Progress is per NOTE (the panel's unit), but embedding batches across
    // notes at the chunk level for throughput. Flatten every chunk in job order
    // (job-major), remembering which job owns each input.
    let total = jobs.len() as u32;
    let _ = app.emit("ai-embed-progress", AiEmbedProgress { done: 0, total });

    let mut flat_inputs: Vec<String> = Vec::new();
    let mut flat_owner: Vec<usize> = Vec::new();
    for (ji, job) in jobs.iter().enumerate() {
        for chunk in &job.chunks {
            flat_inputs.push(chunk.text.clone());
            flat_owner.push(ji);
        }
    }

    // Build the embedder once (loading the local model can download weights on
    // first use); embedding then stays off the engine lock.
    let embedder = build_embedder(&app, &resolved).await?;

    // Buffer each job's chunk vectors until the job is fully embedded, then swap
    // its whole chunk set in one delete+insert (atomic per note). Because the
    // flat order is job-major, jobs complete in index order — flush greedily.
    let mut buffers: Vec<Vec<Vec<f32>>> = jobs
        .iter()
        .map(|j| Vec::with_capacity(j.chunks.len()))
        .collect();
    let mut filled: Vec<usize> = vec![0; jobs.len()];
    let mut flushed = 0usize;
    let mut done = 0u32;
    let mut fi = 0usize;
    for batch in flat_inputs.chunks(EMBED_BATCH) {
        let vecs = embedder.embed_batch(&model, batch).await?;
        for vec in vecs {
            let owner = flat_owner[fi];
            buffers[owner].push(vec);
            filled[owner] += 1;
            fi += 1;
        }

        // Flush every job now fully embedded (contiguous from `flushed`).
        let mut ready: Vec<usize> = Vec::new();
        while flushed < jobs.len() && filled[flushed] == jobs[flushed].chunks.len() {
            ready.push(flushed);
            flushed += 1;
        }
        if !ready.is_empty() {
            app.state::<AppEngine>().with(|e| {
                for &ji in &ready {
                    let pairs: Vec<(vectors::Chunk, Vec<f32>)> = jobs[ji]
                        .chunks
                        .iter()
                        .cloned()
                        .zip(std::mem::take(&mut buffers[ji]))
                        .collect();
                    vectors::upsert_note_chunks(
                        &e.db,
                        &jobs[ji].path,
                        &model,
                        &jobs[ji].content_hash,
                        &pairs,
                    )?;
                }
                Ok(())
            })?;
            done += ready.len() as u32;
            let _ = app.emit("ai-embed-progress", AiEmbedProgress { done, total });
        }
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
    let model = resolve_embedding(&app)?.model().to_string();

    fn stale() -> CommandError {
        CommandError {
            kind: "aiEmbedStale".to_string(),
            message: "this note isn't in the semantic index yet".to_string(),
        }
    }

    // Take the engine lock only to snapshot: the anchor's chunk vectors (+ their
    // shared freshness hash), its title, the raw candidate chunk rows, and the
    // vault path. The per-row f32 decoding, the ANN build + k-NN scan, and the
    // freshness file read all happen off the lock.
    let (anchor, title, rows, vault) = state.with(|e| {
        Ok((
            vectors::anchor_chunks(&e.db, &path, &model)?,
            vectors::note_title(&e.db, &path)?,
            vectors::chunk_rows_for_model(&e.db, &model)?,
            e.vault_path.clone(),
        ))
    })?;

    let (stored_hash, query_vecs) = match anchor {
        Some((hash, vecs)) if !vecs.is_empty() => (hash, vecs),
        _ => return Err(stale()),
    };

    // Freshness: hash what a build would embed right now (same pipeline as
    // collect_stale) and compare with the stored hash. A note that is missing,
    // empty, or a cloud placeholder can't match either — it needs a rebuild.
    let current = title
        .as_deref()
        .and_then(|t| vectors::read_embed_text(&vault, &path, t))
        .map(|full| vectors::content_hash(&full));
    if current.as_deref() != Some(stored_hash.as_str()) {
        return Err(stale());
    }

    // Chunk-level ANN retrieval: the anchor is represented by all its chunks;
    // hits aggregate to the best chunk per note, excluding the anchor itself.
    let cands = vectors::decode_chunk_rows(rows);
    Ok(
        vectors::retrieve_related(&cands, &query_vecs, limit as usize, &path)
            .into_iter()
            .map(|h| RelatedNote {
                path: h.path,
                title: h.title,
                score: h.score as f64,
            })
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// Chat with your vault (RAG): hybrid retrieval → grounded, cited, streamed answer.
// ---------------------------------------------------------------------------

/// Answer a question from the vault. Runs hybrid retrieval (FTS keyword hits ∪
/// vector chunk hits, reciprocal-rank-fused — reusing [`index_search::search`]
/// and [`vectors::retrieve_related`]), returns the top-K passages as `citations`
/// up front, then streams a grounded answer over the shared `ai-stream-*` events
/// (keyed by the returned `request_id`, cancellable via [`ai_cancel`]). The
/// answer cites each claim as `[[n]]`, which the frontend resolves back to
/// `citations[n-1]`.
///
/// Graceful degrade: with no embedding backend configured (or an index not yet
/// built), retrieval falls back to FTS-only. When retrieval finds nothing, the
/// model is **not** called — `request_id` is empty and the frontend shows the
/// honest "not in your notes" message rather than a hallucinated answer.
#[tauri::command]
#[specta::specta]
pub async fn ai_rag_answer(
    app: AppHandle,
    registry: State<'_, AiRegistry>,
    connection_id: String,
    question: String,
) -> CmdResult<RagResponse> {
    let question = question.trim().to_string();
    if question.is_empty() {
        return Err(CommandError {
            kind: "badRequest".to_string(),
            message: "the question is empty".to_string(),
        });
    }

    // Resolve + validate the chat connection up front, so a missing provider/key
    // fails loud before any retrieval work (mirrors `ai_run_action`).
    let conn = find_connection(&app, &connection_id)?;
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
        AiProviderKind::ClaudeCli | AiProviderKind::CodexCli => None,
    };

    // The embedding backend is optional: absent/unbuilt → FTS-only retrieval.
    let embedder = resolve_embedding(&app).ok();
    let model = embedder.as_ref().map(|r| r.model().to_string());

    // Snapshot under a short engine lock: one FTS ranked list per question
    // keyword (each reuses the hardened `search`), the vector candidate chunk
    // rows for the embedding model, and the vault path. All file IO + embedding
    // happen off the lock (a cloud-synced vault can hydrate files during reads).
    let kws = rag::keywords(&question);
    let (fts_lists, fts_meta, cand_rows, vault) = app.state::<AppEngine>().with(|e| {
        let mut lists: Vec<Vec<String>> = Vec::with_capacity(kws.len());
        // path → (title, cleaned snippet) for keyword-only passage assembly.
        let mut meta: HashMap<String, (String, String)> = HashMap::new();
        for kw in &kws {
            let hits = index_search::search(&e.db, kw, None, None)?;
            let mut list = Vec::with_capacity(hits.len());
            for h in hits {
                meta.entry(h.path.clone())
                    .or_insert_with(|| (h.title.clone(), rag::strip_fts_marks(&h.snippet)));
                list.push(h.path);
            }
            lists.push(list);
        }
        let rows = match &model {
            Some(m) => vectors::chunk_rows_for_model(&e.db, m)?,
            None => Vec::new(),
        };
        Ok((lists, meta, rows, e.vault_path.clone()))
    })?;

    // Vector half: embed the QUESTION with the same resolved embedder, then run
    // the reused chunk ANN. Any embedding failure degrades to FTS-only (logged,
    // not fatal) so a network/model hiccup still returns a keyword-grounded
    // answer rather than erroring the whole chat.
    let mut vector_list: Vec<String> = Vec::new();
    let mut vec_hits: HashMap<String, vectors::RelatedChunk> = HashMap::new();
    if let (Some(resolved), false) = (embedder.as_ref(), cand_rows.is_empty()) {
        match embed_question(&app, resolved, &question).await {
            Ok(qvec) => {
                let cands = vectors::decode_chunk_rows(cand_rows);
                for h in vectors::retrieve_related(&cands, &[qvec], rag::DEFAULT_TOP_K * 2, "") {
                    vector_list.push(h.path.clone());
                    vec_hits.insert(h.path.clone(), h);
                }
            }
            Err(e) => log::warn!("RAG: query embedding failed, using FTS only: {}", e.message),
        }
    }

    // Fuse every source (each keyword list + the vector list) into one ranking.
    let mut all_lists = fts_lists;
    all_lists.push(vector_list);
    let ranked = rag::reciprocal_rank_fusion(&all_lists);

    // Assemble the top-K passages: prefer the vector chunk (precise offsets +
    // sliced text) and fall back to the FTS snippet.
    let mut citations: Vec<RagCitation> = Vec::new();
    for fused in ranked.into_iter().take(rag::DEFAULT_TOP_K) {
        let path = fused.key;
        if let Some(hit) = vec_hits.get(&path) {
            let snippet = vectors::read_embed_text(&vault, &path, &hit.title)
                .map(|full| {
                    let src = vectors::truncate_chars(&full, vectors::EMBED_CHAR_BUDGET);
                    rag::passage_slice(&src, hit.char_start, hit.char_end)
                })
                .filter(|s| !s.trim().is_empty())
                // The note vanished/emptied since it was embedded: fall back to
                // any FTS snippet it also matched, else drop it.
                .or_else(|| fts_meta.get(&path).map(|(_, s)| s.clone()));
            if let Some(snippet) = snippet {
                citations.push(RagCitation {
                    id: 0,
                    path: path.clone(),
                    title: hit.title.clone(),
                    char_start: hit.char_start,
                    char_end: hit.char_end,
                    snippet,
                });
            }
        } else if let Some((title, snippet)) = fts_meta.get(&path) {
            citations.push(RagCitation {
                id: 0,
                path: path.clone(),
                title: title.clone(),
                char_start: 0,
                char_end: 0,
                snippet: snippet.clone(),
            });
        }
    }
    // 1-based ids in final rank order, matching the `[[n]]` citation tokens.
    for (i, c) in citations.iter_mut().enumerate() {
        c.id = (i + 1) as u32;
    }

    // Empty retrieval: never call the model — the frontend renders the honest
    // "not in your notes" message from the empty `request_id`.
    if citations.is_empty() {
        return Ok(RagResponse {
            request_id: String::new(),
            citations,
        });
    }

    // Build the grounded prompt (pure) and stream the answer over the shared
    // `ai-stream-*` events, exactly like `ai_run_action`.
    let prompt = rag::build_rag_prompt(&question, &citations);
    let ai_req = AiRequest {
        kind: conn.kind,
        base_url: conn.base_url,
        model: conn.model,
        api_key,
        prompt,
        agentic: false,
        workdir: None,
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let notify = registry.register(&request_id);
    spawn_ai_stream(&app, request_id.clone(), notify, ai_req);

    Ok(RagResponse {
        request_id,
        citations,
    })
}

/// Embed a single question string with a resolved backend (builds the embedder,
/// then runs one batch of one), returning its vector. Off the engine lock.
async fn embed_question(
    app: &AppHandle,
    resolved: &ResolvedEmbedder,
    question: &str,
) -> CmdResult<Vec<f32>> {
    let embedder = build_embedder(app, resolved).await?;
    let inputs = [question.to_string()];
    let mut vecs = embedder.embed_batch(resolved.model(), &inputs).await?;
    vecs.pop().ok_or_else(|| {
        CommandError::internal("the embedding backend returned no vector for the question")
    })
}

/// Spawn the background task that streams `ai_req`'s answer to the frontend over
/// the shared `ai-stream-*` events (keyed by `request_id`) and clears the
/// cancellation-registry entry when done. Mirrors the tail of [`ai_run_action`].
fn spawn_ai_stream(app: &AppHandle, request_id: String, notify: Arc<Notify>, ai_req: AiRequest) {
    let app_task = app.clone();
    let id_task = request_id;
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
