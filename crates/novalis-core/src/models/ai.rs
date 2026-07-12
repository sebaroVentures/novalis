//! Shared data types for the AI/LLM subsystem. All of these are pure DTOs that
//! cross the IPC boundary, so each derives [`specta::Type`] and serializes with
//! camelCase keys, matching the rest of [`crate::models`].
//!
//! Secrets never live here: an [`AiConnectionConfig`] holds only non-sensitive
//! configuration. API keys are stored in the OS keychain by the desktop shell
//! and are never serialized into a config or returned to the frontend.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Which kind of backend a connection talks to. The HTTP kinds hit a remote
/// API; the CLI kinds shell out to a locally-installed tool that uses the
/// user's own login/subscription.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiProviderKind {
    /// Anthropic Claude — `POST /v1/messages`.
    Anthropic,
    /// OpenAI and any OpenAI-compatible service (DeepSeek, …) —
    /// `POST {base_url}/v1/chat/completions`. Distinguished only by `base_url`
    /// and `model`.
    OpenAiCompatible,
    /// Locally-installed Claude Code (`claude`) CLI. (Adapter lands in Phase 2.)
    ClaudeCli,
    /// Locally-installed OpenAI Codex (`codex`) CLI. (Adapter lands in Phase 2.)
    CodexCli,
}

/// A chat message role. Serializes to the lowercase strings both the Anthropic
/// and OpenAI wire formats use (`system`/`user`/`assistant`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChatRole {
    System,
    User,
    Assistant,
}

/// A single chat message. The `system` prompt is carried separately in a
/// [`crate::ai::BuiltPrompt`]; messages here are only `user`/`assistant`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

/// Whether an action accepts a free-text user prompt in addition to the note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiInputKind {
    /// No extra input — the note is the whole task (e.g. summarize).
    None,
    /// Optional extra instruction.
    Optional,
    /// A prompt is required (e.g. "write content from this brief").
    Required,
}

/// Which slice of the note an action operates on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiScope {
    WholeNote,
    Selection,
    /// Prefer the selection, fall back to the whole note when nothing is
    /// selected.
    SelectionOrWholeNote,
}

/// The default way the result should be applied to the note. A hint for the
/// frontend panel; the user can always override.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiInsertMode {
    /// Show in the panel only; the user chooses what to do.
    PanelOnly,
    /// Insert at the cursor.
    AtCursor,
    /// Replace the current selection.
    ReplaceSelection,
    /// Append to the end of the note.
    Append,
}

/// Non-secret configuration for one connection. Persisted app-global in the
/// desktop settings file. The matching API key (HTTP kinds) lives in the OS
/// keychain under `ai:<id>` and is never stored here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiConnectionConfig {
    /// Stable identifier (also the keychain account suffix).
    pub id: String,
    pub kind: AiProviderKind,
    /// Human-readable name shown in the picker.
    pub label: String,
    /// Base URL for OpenAI-compatible services (e.g. `https://api.deepseek.com`).
    /// Optional for Anthropic (defaults to the public API) and unused for CLI.
    #[serde(default)]
    pub base_url: Option<String>,
    /// Model identifier sent to the provider / passed to the CLI `--model`.
    pub model: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// CLI kinds only: run the agent INSIDE the vault with a curated file
    /// toolset (open-ended edits) instead of the default sandboxed, no-tools
    /// text generation in a temp dir. Opt-in and ignored for HTTP kinds. Every
    /// agentic run is bracketed by a git checkpoint so it can be reverted.
    #[serde(default)]
    pub agentic: bool,
}

fn default_true() -> bool {
    true
}

/// A suggested model for a provider, shown in the settings dropdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiModelInfo {
    pub id: String,
    pub label: String,
}

/// A connection enriched with runtime status for the frontend: whether it has a
/// key (`configured`), whether the backend is reachable/installed (`available`),
/// and the suggested model catalog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiConnectionView {
    pub id: String,
    pub kind: AiProviderKind,
    pub label: String,
    pub base_url: Option<String>,
    pub model: String,
    pub enabled: bool,
    /// Mirrors [`AiConnectionConfig::agentic`] (CLI kinds only).
    pub agentic: bool,
    /// HTTP kinds: an API key is stored. CLI kinds: the binary is detected.
    pub configured: bool,
    /// HTTP kinds: always true. CLI kinds: the binary is on PATH / configured.
    pub available: bool,
    pub models: Vec<AiModelInfo>,
}

/// Metadata describing one runnable action, surfaced to the editor picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiActionView {
    pub id: String,
    /// i18n key (namespace `ai`) for the display title.
    pub title_key: String,
    pub input: AiInputKind,
    pub scope: AiScope,
    pub insert_mode: AiInsertMode,
}

/// The note context an action runs against, sent from the editor.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiContext {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub markdown: String,
    #[serde(default)]
    pub selection: Option<String>,
}

/// Input to `ai_run_action`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiRunRequest {
    pub connection_id: String,
    pub action_id: String,
    #[serde(default)]
    pub note_path: Option<String>,
    pub context: AiContext,
    #[serde(default)]
    pub user_input: Option<String>,
}

/// Where a prompt template is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AiTemplateScope {
    /// App config dir — available in every vault on this machine.
    Global,
    /// `<vault>/.novalis/ai-prompts/` — synced with the vault via git.
    Vault,
}

/// A user-defined prompt template stored as a `.md` file. The file name is the
/// display `name`; the file contents are the prompt `body`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiTemplate {
    /// File name (with extension) — the identifier for delete (within a scope).
    pub id: String,
    pub name: String,
    pub body: String,
    pub scope: AiTemplateScope,
}

/// Which connection + model produce note embeddings. References an existing
/// [`AiConnectionConfig`] by id (so base URL + keychain key are not duplicated);
/// the embedding `model` is separate because it differs from the chat model on
/// the same endpoint. Persisted app-global in the desktop settings file; the
/// referenced connection must be [`AiProviderKind::OpenAiCompatible`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiEmbeddingConfig {
    /// Id of the OpenAI-compatible connection that provides base URL + API key,
    /// or [`LOCAL_EMBEDDING_CONNECTION_ID`] to use the bundled on-device model.
    pub connection_id: String,
    /// Embedding model id (e.g. `text-embedding-3-small`, `nomic-embed-text`).
    /// Fixed to [`LOCAL_EMBEDDING_MODEL`] for the bundled model.
    pub model: String,
}

/// Reserved [`AiEmbeddingConfig::connection_id`] value that selects the bundled,
/// on-device embedding model instead of referencing an OpenAI-compatible
/// connection. Real connection ids are UUIDs, so this sentinel can never
/// collide. The desktop shell resolves it to its native embedder; the settings
/// UI offers it as the "Local (bundled)" choice. It lives here — not in the
/// desktop crate — so the config resolver and the frontend agree on the exact
/// string, the same way the AI error `kind`s are shared across the IPC boundary.
pub const LOCAL_EMBEDDING_CONNECTION_ID: &str = "local";

/// The `note_vectors.model` id stored for vectors produced by the bundled
/// on-device model (bge-small-en-v1.5, 384-dim). Namespaced so local vectors
/// coexist with any remote model's vectors under a distinct `model` column.
pub const LOCAL_EMBEDDING_MODEL: &str = "local:bge-small-en-v1.5";

/// Coverage of the semantic index, for the settings panel. Carries no secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EmbedStatus {
    /// A valid, enabled OpenAI-compatible embedding connection is configured.
    pub configured: bool,
    /// The configured embedding model, when `configured`.
    pub model: Option<String>,
    /// Notes eligible to embed (local, non-placeholder).
    pub total: u32,
    /// Notes that currently have a vector for the configured model.
    pub embedded: u32,
}

/// A semantically related note returned by "find related" / semantic search.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RelatedNote {
    pub path: String,
    pub title: String,
    /// Cosine similarity in `[-1, 1]` (typically `[0, 1]` for text embeddings).
    pub score: f64,
}

/// One retrieved passage backing a "chat with your vault" answer. The model
/// cites it as `[[id]]` (see [`crate::ai::rag::format_citation`]); the frontend
/// resolves that token back to this note + character span to make the citation
/// clickable. `snippet` is the passage text — both shown as a preview and fed to
/// the model as grounding.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RagCitation {
    /// 1-based passage number, matching the `[[id]]` token in the answer.
    pub id: u32,
    pub path: String,
    pub title: String,
    /// Character offsets of the passage into the note's embed text (title+body).
    /// `0..0` for a keyword-only (FTS) hit that carries no precise chunk span.
    pub char_start: u32,
    pub char_end: u32,
    /// The passage text (also the grounding sent to the model).
    pub snippet: String,
}

/// Result of starting a RAG answer: the retrieved citations (returned up front
/// so the panel can render them immediately) plus the streaming `request_id`
/// whose answer text arrives over the shared `ai-stream-*` events and is
/// cancellable via `ai_cancel`. `request_id` is **empty** when retrieval found
/// nothing — the backend never calls the model, and the frontend shows the
/// honest "not in your notes" message instead of a hallucinated answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RagResponse {
    pub request_id: String,
    pub citations: Vec<RagCitation>,
}

/// Token usage reported by a provider when available.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: Option<u32>,
    #[serde(default)]
    pub output_tokens: Option<u32>,
}
