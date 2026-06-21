//! OpenAI-compatible embeddings adapter (`POST {base}/v1/embeddings`). Covers
//! OpenAI, Ollama (its OpenAI-compat endpoint at the server root, e.g.
//! `http://localhost:11434`), and LM Studio. Reuses the chat adapter's base-URL
//! normalization and the shared error mapping in [`super`] so embedding errors
//! produce the same `aiAuth/aiRateLimit/aiBadRequest/aiServer/aiNetwork` kinds
//! the frontend already branches on.
//!
//! Note: this sends note text to the configured endpoint. That is fine because
//! the feature is opt-in and the endpoint is whatever the user configured
//! (commonly a local model) — but it IS a network call, so it lives entirely on
//! the async runtime, never under the engine lock.

use serde::Deserialize;
use serde_json::json;

use super::openai_compat::base_url;
use crate::engine::CommandError;

/// Conservative default batch size. Many endpoints accept an array `input`; some
/// older Ollama builds accept only a single string — [`embed_batch`] falls back
/// to one-per-request on a 4xx, so this is just an efficiency knob.
const BATCH: usize = 16;

#[derive(Deserialize)]
struct EmbeddingsResponse {
    data: Vec<EmbeddingRow>,
}

#[derive(Deserialize)]
struct EmbeddingRow {
    embedding: Vec<f32>,
    #[serde(default)]
    index: Option<usize>,
}

fn bad_request(msg: impl Into<String>) -> CommandError {
    CommandError {
        kind: "aiBadRequest".to_string(),
        message: msg.into(),
    }
}

/// Embed `inputs` in chunks of [`BATCH`], returning one vector per input in the
/// same order. On a per-batch `aiBadRequest` (the only kind that signals "this
/// endpoint won't take an array"), retries that chunk one input at a time.
pub async fn embed_batch(
    client: &reqwest::Client,
    base: Option<&str>,
    api_key: Option<&str>,
    model: &str,
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, CommandError> {
    let mut out: Vec<Vec<f32>> = Vec::with_capacity(inputs.len());
    for chunk in inputs.chunks(BATCH) {
        match embed_request(client, base, api_key, model, chunk).await {
            Ok(mut vecs) => out.append(&mut vecs),
            Err(e) if e.kind == "aiBadRequest" && chunk.len() > 1 => {
                // Single-input fallback for endpoints that reject array `input`.
                for one in chunk {
                    let mut v =
                        embed_request(client, base, api_key, model, std::slice::from_ref(one))
                            .await?;
                    out.push(
                        v.pop()
                            .ok_or_else(|| bad_request("embeddings: empty response"))?,
                    );
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(out)
}

/// One `/v1/embeddings` request. Validates count, dimension consistency, and
/// finiteness so a malformed response can't poison cosine math downstream.
async fn embed_request(
    client: &reqwest::Client,
    base: Option<&str>,
    api_key: Option<&str>,
    model: &str,
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, CommandError> {
    let body = json!({ "model": model, "input": inputs });
    let resp = client
        .post(format!("{}/v1/embeddings", base_url(base)))
        // Empty bearer is harmless for OpenAI/LM Studio and required-absent for
        // local Ollama; mirrors the chat adapter exactly.
        .bearer_auth(api_key.unwrap_or_default())
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| super::net_err("embeddings", e))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(super::map_status_error(
            status.as_u16(),
            &text,
            "embeddings",
        ));
    }

    let parsed: EmbeddingsResponse = resp
        .json()
        .await
        .map_err(|e| super::net_err("embeddings", e))?;

    let mut data = parsed.data;
    // Honor `index` when every row carries one; otherwise trust positional order.
    if !data.is_empty() && data.iter().all(|d| d.index.is_some()) {
        data.sort_by_key(|d| d.index.unwrap_or(0));
    }

    if data.len() != inputs.len() {
        return Err(bad_request(format!(
            "embeddings: expected {} vectors, got {}",
            inputs.len(),
            data.len()
        )));
    }

    let vecs: Vec<Vec<f32>> = data.into_iter().map(|d| d.embedding).collect();
    let dim = vecs.first().map(Vec::len).unwrap_or(0);
    if dim == 0 {
        return Err(bad_request("embeddings: empty embedding returned"));
    }
    let mut any_nonzero = false;
    for v in &vecs {
        if v.len() != dim {
            return Err(bad_request("embeddings: inconsistent vector dimensions"));
        }
        if v.iter().any(|x| !x.is_finite()) {
            return Err(bad_request("embeddings: non-finite values in embedding"));
        }
        any_nonzero |= v.iter().any(|x| *x != 0.0);
    }
    if !any_nonzero {
        return Err(bad_request(
            "embeddings: all-zero embeddings (check the model)",
        ));
    }

    Ok(vecs)
}
