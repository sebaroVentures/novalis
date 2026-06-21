//! Desktop adapters for the AI subsystem: HTTP providers, OS-keychain key
//! storage, the in-flight cancellation registry, and the Tauri commands. The
//! provider-agnostic domain logic (action registry, prompt building, SSE
//! parsing) lives in `novalis_core::ai`.

pub mod anthropic;
pub mod catalog;
pub mod cli;
pub mod commands;
pub mod embeddings;
pub mod keychain;
pub mod openai_compat;
pub mod registry;
pub mod templates;

use std::sync::Arc;

use futures_util::StreamExt;
use tokio::sync::Notify;

use novalis_core::ai::{
    merge_usage, parse_anthropic_event, parse_openai_chunk, BuiltPrompt, SseLineBuffer, SseRecord,
    StreamDelta,
};
use novalis_core::models::{AiProviderKind, ChatRole, Usage};

use crate::engine::CommandError;

/// Everything a provider needs to run one completion.
pub struct AiRequest {
    pub kind: AiProviderKind,
    pub base_url: Option<String>,
    pub model: String,
    /// API key for HTTP kinds; unused for CLI kinds.
    pub api_key: Option<String>,
    pub prompt: BuiltPrompt,
    /// CLI kinds only: run inside the vault with a curated file toolset rather
    /// than sandboxed text generation in a temp dir. Honored only when
    /// `workdir` is also set.
    pub agentic: bool,
    /// The directory to run a CLI in (the vault, for agentic runs). When unset,
    /// CLI runs default to a temp dir so the agent cannot touch the vault.
    pub workdir: Option<std::path::PathBuf>,
}

/// Wire role string shared by the provider request builders.
pub(crate) fn role_str(role: ChatRole) -> &'static str {
    match role {
        ChatRole::System => "system",
        ChatRole::User => "user",
        ChatRole::Assistant => "assistant",
    }
}

fn net_err(provider: &str, e: reqwest::Error) -> CommandError {
    CommandError {
        kind: "aiNetwork".to_string(),
        message: format!("{provider} request failed: {e}"),
    }
}

fn map_status_error(status: u16, body: &str, provider: &str) -> CommandError {
    let kind = match status {
        401 | 403 => "aiAuth",
        429 => "aiRateLimit",
        400 | 404 | 422 => "aiBadRequest",
        _ => "aiServer",
    };
    let message = extract_error_message(body)
        .unwrap_or_else(|| format!("{provider} request failed (HTTP {status})"));
    CommandError {
        kind: kind.to_string(),
        message,
    }
}

/// Pull a clean message out of an Anthropic/OpenAI JSON error body.
fn extract_error_message(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v.get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .or_else(|| v.get("message").and_then(|m| m.as_str()))
        .map(str::to_string)
}

/// Run a streaming completion, invoking `on_text` for each text delta and
/// returning the accumulated usage. Cooperatively cancellable via `cancel`.
pub async fn run_stream<F: FnMut(&str)>(
    req: AiRequest,
    cancel: Arc<Notify>,
    on_text: F,
) -> Result<Usage, CommandError> {
    let client = reqwest::Client::new();
    match req.kind {
        AiProviderKind::Anthropic => {
            let rb = anthropic::build_request(&client, &req);
            stream_http(
                rb,
                cancel,
                |r| parse_anthropic_event(r.event.as_deref(), &r.data),
                on_text,
                "Anthropic",
            )
            .await
        }
        AiProviderKind::OpenAiCompatible => {
            let rb = openai_compat::build_request(&client, &req);
            stream_http(
                rb,
                cancel,
                |r| parse_openai_chunk(&r.data),
                on_text,
                "service",
            )
            .await
        }
        AiProviderKind::ClaudeCli | AiProviderKind::CodexCli => {
            cli::stream(req, cancel, on_text).await
        }
    }
}

/// Key-only auth check for HTTP connections (lists models; spends no tokens).
pub async fn test_connection(
    kind: AiProviderKind,
    base_url: Option<&str>,
    api_key: Option<&str>,
) -> Result<(), CommandError> {
    let client = reqwest::Client::new();
    let (rb, provider) = match kind {
        AiProviderKind::Anthropic => (
            anthropic::build_test(&client, base_url, api_key),
            "Anthropic",
        ),
        AiProviderKind::OpenAiCompatible => (
            openai_compat::build_test(&client, base_url, api_key),
            "service",
        ),
        AiProviderKind::ClaudeCli | AiProviderKind::CodexCli => {
            return cli::test(kind, base_url).await
        }
    };
    let resp = rb.send().await.map_err(|e| net_err(provider, e))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        Err(map_status_error(status.as_u16(), &body, provider))
    }
}

async fn stream_http<P, F>(
    rb: reqwest::RequestBuilder,
    cancel: Arc<Notify>,
    parse: P,
    mut on_text: F,
    provider: &str,
) -> Result<Usage, CommandError>
where
    P: Fn(&SseRecord) -> Option<StreamDelta>,
    F: FnMut(&str),
{
    let resp = rb.send().await.map_err(|e| net_err(provider, e))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(map_status_error(status.as_u16(), &body, provider));
    }

    let mut stream = resp.bytes_stream();
    let mut sse = SseLineBuffer::new();
    let mut usage = Usage::default();

    let cancelled = cancel.notified();
    tokio::pin!(cancelled);

    loop {
        tokio::select! {
            _ = &mut cancelled => {
                // Caller initiated the cancel; return the partial usage so the
                // command can finalize the stream normally.
                return Ok(usage);
            }
            item = stream.next() => match item {
                None => break,
                Some(Err(e)) => {
                    return Err(CommandError {
                        kind: "aiNetwork".to_string(),
                        message: format!("stream error: {e}"),
                    });
                }
                Some(Ok(bytes)) => {
                    for rec in sse.push(&bytes) {
                        match parse(&rec) {
                            Some(StreamDelta::Text(t)) => on_text(&t),
                            Some(StreamDelta::Usage(u)) => merge_usage(&mut usage, u),
                            Some(StreamDelta::Error(msg)) => {
                                return Err(CommandError { kind: "aiServer".to_string(), message: msg });
                            }
                            Some(StreamDelta::Done) => {
                                return Ok(usage);
                            }
                            None => {}
                        }
                    }
                }
            }
        }
    }

    // Stream closed without an explicit terminator: flush any trailing record.
    if let Some(rec) = sse.finish() {
        match parse(&rec) {
            Some(StreamDelta::Text(t)) => on_text(&t),
            Some(StreamDelta::Usage(u)) => merge_usage(&mut usage, u),
            _ => {}
        }
    }
    Ok(usage)
}
