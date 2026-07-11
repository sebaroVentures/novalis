//! Desktop adapters for the AI subsystem: HTTP providers, OS-keychain key
//! storage, the in-flight cancellation registry, and the Tauri commands. The
//! provider-agnostic domain logic (action registry, prompt building, SSE
//! parsing) lives in `novalis_core::ai`.

pub mod anthropic;
pub mod catalog;
pub mod cli;
pub mod commands;
// Bundled on-device embeddings (desktop only — no prebuilt ONNX Runtime on
// Android, mirroring the keyring backend in `crate::secrets`).
#[cfg(not(target_os = "android"))]
pub mod embed_local;
pub mod embeddings;
pub mod keychain;
pub mod openai_compat;
pub mod registry;
pub mod templates;

use std::sync::Arc;
use std::time::Duration;

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

/// TCP connect timeout for every AI HTTP client — a peer that never accepts
/// the connection must not hang a run forever.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Client for streaming completions: connect timeout only. No total request
/// deadline — long streams are legitimate.
fn streaming_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .expect("failed to build HTTP client")
}

/// Client for non-streaming calls: connect timeout plus a total per-request
/// deadline, so a stalled response can't wedge the caller.
pub(crate) fn bounded_client(total: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(total)
        .build()
        .expect("failed to build HTTP client")
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
    let client = streaming_client();
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
    let client = bounded_client(Duration::from_secs(30));
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

/// A hand-rolled localhost HTTP/1.1 server for tests: plays back canned
/// responses (one connection per response — every reply sends
/// `Connection: close`, so reqwest reconnects for the next request) and
/// captures the raw requests it received. No extra dev-dependencies.
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    pub(crate) struct CannedResponse {
        pub status: u16,
        pub content_type: &'static str,
        pub body: &'static str,
        /// `true`: send `Content-Length` (a complete HTTP body). `false`: omit
        /// it and end the body by closing the socket — models a streaming
        /// server that drops the connection without a protocol terminator.
        pub sized: bool,
    }

    impl CannedResponse {
        pub(crate) fn json(status: u16, body: &'static str) -> Self {
            Self {
                status,
                content_type: "application/json",
                body,
                sized: true,
            }
        }

        pub(crate) fn sse(body: &'static str, sized: bool) -> Self {
            Self {
                status: 200,
                content_type: "text/event-stream",
                body,
                sized,
            }
        }
    }

    /// Serve `responses` in order on an ephemeral port; returns the base URL
    /// plus the captured request payloads (request line, headers, and body).
    pub(crate) async fn spawn_server(
        responses: Vec<CannedResponse>,
    ) -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let captured = Arc::new(Mutex::new(Vec::new()));
        let cap = captured.clone();
        tokio::spawn(async move {
            for resp in responses {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let req = read_request(&mut sock).await;
                cap.lock().unwrap().push(req);
                let length = if resp.sized {
                    format!("content-length: {}\r\n", resp.body.len())
                } else {
                    String::new()
                };
                let head = format!(
                    "HTTP/1.1 {} Test\r\ncontent-type: {}\r\n{}connection: close\r\n\r\n",
                    resp.status, resp.content_type, length
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(resp.body.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (base, captured)
    }

    /// Read one HTTP request: headers, then `Content-Length` bytes of body.
    async fn read_request(sock: &mut TcpStream) -> String {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 1024];
        loop {
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..pos]).to_string();
                let len = head
                    .lines()
                    .find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        k.trim()
                            .eq_ignore_ascii_case("content-length")
                            .then(|| v.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                while buf.len() < pos + 4 + len {
                    match sock.read(&mut tmp).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    }
                }
                return String::from_utf8_lossy(&buf).to_string();
            }
            match sock.read(&mut tmp).await {
                Ok(0) | Err(_) => return String::from_utf8_lossy(&buf).to_string(),
                Ok(n) => buf.extend_from_slice(&tmp[..n]),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use novalis_core::models::{ChatMessage, ChatRole};

    use super::test_support::{spawn_server, CannedResponse};
    use super::*;

    fn request(kind: AiProviderKind, base: &str) -> AiRequest {
        AiRequest {
            kind,
            base_url: Some(base.to_string()),
            model: "test-model".to_string(),
            api_key: Some("sk-test".to_string()),
            prompt: BuiltPrompt {
                system: "be brief".to_string(),
                messages: vec![ChatMessage {
                    role: ChatRole::User,
                    content: "hello".to_string(),
                }],
            },
            agentic: false,
            workdir: None,
        }
    }

    /// Run `run_stream` against a mock server with a test timeout, collecting
    /// the emitted text.
    async fn run(req: AiRequest) -> (Result<Usage, CommandError>, String) {
        let mut out = String::new();
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            run_stream(req, Arc::new(Notify::new()), |t| out.push_str(t)),
        )
        .await
        .expect("stream test timed out");
        (result, out)
    }

    #[tokio::test]
    async fn anthropic_stream_happy_path() {
        let body = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":42}}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{},\"usage\":{\"output_tokens\":7}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let (base, captured) = spawn_server(vec![CannedResponse::sse(body, true)]).await;

        let (result, text) = run(request(AiProviderKind::Anthropic, &base)).await;
        assert_eq!(text, "Hello");
        assert_eq!(
            result.unwrap(),
            Usage {
                input_tokens: Some(42),
                output_tokens: Some(7),
            }
        );

        // The request that actually went over the wire.
        let reqs = captured.lock().unwrap();
        assert!(reqs[0].starts_with("POST /v1/messages "));
        assert!(reqs[0].contains("x-api-key: sk-test"));
        assert!(reqs[0].contains("anthropic-version:"));
        assert!(reqs[0].contains("\"model\":\"test-model\""));
        assert!(reqs[0].contains("\"stream\":true"));
    }

    #[tokio::test]
    async fn anthropic_stream_abrupt_close_keeps_partial_output() {
        // The server drops the connection mid-stream: no message_stop, and the
        // final record has no terminating blank line.
        let body = concat!(
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{},\"usage\":{\"output_tokens\":3}}\n",
        );
        let (base, _) = spawn_server(vec![CannedResponse::sse(body, false)]).await;

        let (result, text) = run(request(AiProviderKind::Anthropic, &base)).await;
        assert_eq!(text, "Hi");
        // The unterminated trailing record is still flushed and merged.
        assert_eq!(result.unwrap().output_tokens, Some(3));
    }

    #[tokio::test]
    async fn openai_stream_happy_path() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"finish_reason\":null}],\"usage\":null}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\" there\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3}}\n\n",
            "data: [DONE]\n\n",
        );
        let (base, captured) = spawn_server(vec![CannedResponse::sse(body, true)]).await;

        let (result, text) = run(request(AiProviderKind::OpenAiCompatible, &base)).await;
        assert_eq!(text, "Hi there");
        assert_eq!(
            result.unwrap(),
            Usage {
                input_tokens: Some(10),
                output_tokens: Some(3),
            }
        );

        let reqs = captured.lock().unwrap();
        assert!(reqs[0].starts_with("POST /v1/chat/completions "));
        assert!(reqs[0].contains("authorization: Bearer sk-test"));
        // The system prompt travels as a message (OpenAI has no system field).
        // Key order inside objects depends on serde_json features, so assert
        // the fragments independently.
        assert!(reqs[0].contains("\"content\":\"be brief\""));
        assert!(reqs[0].contains("\"role\":\"system\""));
    }

    #[tokio::test]
    async fn openai_stream_abrupt_close_keeps_partial_output() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n";
        let (base, _) = spawn_server(vec![CannedResponse::sse(body, false)]).await;

        let (result, text) = run(request(AiProviderKind::OpenAiCompatible, &base)).await;
        assert_eq!(text, "partial");
        // No [DONE] ever arrived; the partial result still finalizes cleanly.
        assert_eq!(result.unwrap(), Usage::default());
    }

    #[tokio::test]
    async fn http_error_status_maps_to_typed_error() {
        let (base, _) = spawn_server(vec![CannedResponse::json(
            401,
            r#"{"error":{"message":"invalid x-api-key"}}"#,
        )])
        .await;

        let (result, text) = run(request(AiProviderKind::Anthropic, &base)).await;
        assert!(text.is_empty());
        let err = result.unwrap_err();
        assert_eq!(err.kind, "aiAuth");
        assert_eq!(err.message, "invalid x-api-key");
    }

    #[tokio::test]
    async fn mid_stream_provider_error_surfaces_as_server_error() {
        let body = concat!(
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"a\"}}\n\n",
            "event: error\n",
            "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"busy\"}}\n\n",
        );
        let (base, _) = spawn_server(vec![CannedResponse::sse(body, true)]).await;

        let (result, text) = run(request(AiProviderKind::Anthropic, &base)).await;
        assert_eq!(text, "a");
        let err = result.unwrap_err();
        assert_eq!(err.kind, "aiServer");
        assert_eq!(err.message, "busy");
    }
}
