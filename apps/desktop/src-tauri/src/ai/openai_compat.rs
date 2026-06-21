//! OpenAI-compatible Chat Completions adapter — covers OpenAI, DeepSeek, and any
//! other service exposing `/v1/chat/completions`, distinguished only by
//! `base_url` and `model`. Response parsing lives in `novalis_core::ai::sse`.

use serde_json::json;

use super::{role_str, AiRequest};

const DEFAULT_BASE: &str = "https://api.openai.com";

pub(crate) fn base_url(base: Option<&str>) -> String {
    base.map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_BASE)
        .trim_end_matches('/')
        .to_string()
}

/// Build the streaming completion request. The system prompt becomes the first
/// `system` message (OpenAI has no separate system field).
pub fn build_request(client: &reqwest::Client, req: &AiRequest) -> reqwest::RequestBuilder {
    let mut messages = vec![json!({ "role": "system", "content": req.prompt.system })];
    for m in &req.prompt.messages {
        messages.push(json!({ "role": role_str(m.role), "content": m.content }));
    }

    let body = json!({
        "model": req.model,
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": messages,
    });

    client
        .post(format!(
            "{}/v1/chat/completions",
            base_url(req.base_url.as_deref())
        ))
        .bearer_auth(req.api_key.clone().unwrap_or_default())
        .header("content-type", "application/json")
        .json(&body)
}

/// A key-only auth check: list models (no tokens spent).
pub fn build_test(
    client: &reqwest::Client,
    base: Option<&str>,
    api_key: Option<&str>,
) -> reqwest::RequestBuilder {
    client
        .get(format!("{}/v1/models", base_url(base)))
        .bearer_auth(api_key.unwrap_or_default())
}
