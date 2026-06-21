//! Anthropic Messages API adapter — builds the streaming `/v1/messages`
//! request. Response parsing lives in `novalis_core::ai::sse`.

use serde_json::json;

use super::{role_str, AiRequest};

const DEFAULT_BASE: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 16000;

fn base_url(req: &AiRequest) -> String {
    let base = req
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_BASE);
    base.trim_end_matches('/').to_string()
}

/// Build the streaming completion request.
pub fn build_request(client: &reqwest::Client, req: &AiRequest) -> reqwest::RequestBuilder {
    let messages: Vec<_> = req
        .prompt
        .messages
        .iter()
        .map(|m| json!({ "role": role_str(m.role), "content": m.content }))
        .collect();

    let body = json!({
        "model": req.model,
        "max_tokens": MAX_TOKENS,
        "system": req.prompt.system,
        // Adaptive thinking is the on-mode for current Claude models; the raw
        // reasoning is never returned and we only render text deltas.
        "thinking": { "type": "adaptive" },
        "stream": true,
        "messages": messages,
    });

    client
        .post(format!("{}/v1/messages", base_url(req)))
        .header("x-api-key", req.api_key.clone().unwrap_or_default())
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
}

/// A key-only auth check: list models (no tokens spent).
pub fn build_test(client: &reqwest::Client, base: Option<&str>, api_key: Option<&str>) -> reqwest::RequestBuilder {
    let base = base
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_BASE)
        .trim_end_matches('/');
    client
        .get(format!("{base}/v1/models"))
        .header("x-api-key", api_key.unwrap_or_default())
        .header("anthropic-version", ANTHROPIC_VERSION)
}
