//! A small, dependency-free Server-Sent Events reader plus the per-provider
//! record parsers. Kept in core so the framing and JSON handling are unit-tested
//! with fixture strings rather than against a live network.
//!
//! [`SseLineBuffer`] accumulates raw bytes (which may split arbitrarily across
//! network chunks) and yields complete [`SseRecord`]s on blank-line boundaries.
//! [`parse_anthropic_event`] and [`parse_openai_chunk`] turn a record into a
//! [`StreamDelta`].

use serde_json::Value;

use crate::models::Usage;

/// A semantic unit emitted while streaming a completion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamDelta {
    /// A chunk of assistant text to append to the output.
    Text(String),
    /// Partial token-usage info to merge into the running total.
    Usage(Usage),
    /// A provider-reported error mid-stream.
    Error(String),
    /// The stream finished normally.
    Done,
}

/// One parsed SSE record: an optional `event:` type and its joined `data:` body.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SseRecord {
    pub event: Option<String>,
    pub data: String,
}

/// Incremental SSE framer. Feed it raw bytes from the response stream; it
/// returns whole records as their blank-line terminators arrive.
#[derive(Default)]
pub struct SseLineBuffer {
    buf: Vec<u8>,
    event: Option<String>,
    data: String,
    has_fields: bool,
}

impl SseLineBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a network chunk and return any records it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseRecord> {
        self.buf.extend_from_slice(chunk);
        let mut records = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = self.buf.drain(..=nl).collect();
            // Decode the line without the trailing '\n' (a single safe byte).
            let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1]);
            let line = line.strip_suffix('\r').unwrap_or(&line);
            if line.is_empty() {
                if let Some(rec) = self.take_record() {
                    records.push(rec);
                }
            } else if let Some(rest) = line.strip_prefix("data:") {
                let v = rest.strip_prefix(' ').unwrap_or(rest);
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(v);
                self.has_fields = true;
            } else if let Some(rest) = line.strip_prefix("event:") {
                self.event = Some(rest.strip_prefix(' ').unwrap_or(rest).to_string());
                self.has_fields = true;
            }
            // Other fields (id:, retry:) and comment lines (":...") are ignored.
        }
        records
    }

    /// Flush any record buffered without a trailing blank line (end of stream).
    pub fn finish(&mut self) -> Option<SseRecord> {
        self.take_record()
    }

    fn take_record(&mut self) -> Option<SseRecord> {
        if !self.has_fields {
            return None;
        }
        let rec = SseRecord {
            event: self.event.take(),
            data: std::mem::take(&mut self.data),
        };
        self.has_fields = false;
        Some(rec)
    }
}

/// Parse one Anthropic Messages-API SSE record (`/v1/messages` with
/// `stream:true`).
pub fn parse_anthropic_event(event: Option<&str>, data: &str) -> Option<StreamDelta> {
    match event? {
        "content_block_delta" => {
            let v: Value = serde_json::from_str(data).ok()?;
            let delta = v.get("delta")?;
            match delta.get("type")?.as_str()? {
                "text_delta" => Some(StreamDelta::Text(delta.get("text")?.as_str()?.to_string())),
                // thinking_delta / input_json_delta: not surfaced to the user.
                _ => None,
            }
        }
        "message_start" => {
            let v: Value = serde_json::from_str(data).ok()?;
            let input = v
                .get("message")?
                .get("usage")?
                .get("input_tokens")
                .and_then(Value::as_u64)?;
            Some(StreamDelta::Usage(Usage {
                input_tokens: Some(input as u32),
                output_tokens: None,
            }))
        }
        "message_delta" => {
            let v: Value = serde_json::from_str(data).ok()?;
            let output = v
                .get("usage")?
                .get("output_tokens")
                .and_then(Value::as_u64)?;
            Some(StreamDelta::Usage(Usage {
                input_tokens: None,
                output_tokens: Some(output as u32),
            }))
        }
        "message_stop" => Some(StreamDelta::Done),
        "error" => {
            let v: Value = serde_json::from_str(data).ok()?;
            let msg = v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("stream error")
                .to_string();
            Some(StreamDelta::Error(msg))
        }
        _ => None,
    }
}

/// Parse one OpenAI-compatible `chat/completions` SSE `data:` payload.
pub fn parse_openai_chunk(data: &str) -> Option<StreamDelta> {
    let data = data.trim();
    if data == "[DONE]" {
        return Some(StreamDelta::Done);
    }
    let v: Value = serde_json::from_str(data).ok()?;

    if let Some(err) = v.get("error") {
        let msg = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("stream error")
            .to_string();
        return Some(StreamDelta::Error(msg));
    }

    // Final usage chunk: `choices` is empty and `usage` is populated.
    if let Some(usage) = v.get("usage").filter(|u| !u.is_null()) {
        let input = usage
            .get("prompt_tokens")
            .and_then(Value::as_u64)
            .map(|n| n as u32);
        let output = usage
            .get("completion_tokens")
            .and_then(Value::as_u64)
            .map(|n| n as u32);
        if input.is_some() || output.is_some() {
            return Some(StreamDelta::Usage(Usage {
                input_tokens: input,
                output_tokens: output,
            }));
        }
    }

    let content = v
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()?;
    if content.is_empty() {
        return None;
    }
    Some(StreamDelta::Text(content.to_string()))
}

/// Merge partial usage info, letting later values win for the fields they set.
pub fn merge_usage(into: &mut Usage, other: Usage) {
    if other.input_tokens.is_some() {
        into.input_tokens = other.input_tokens;
    }
    if other.output_tokens.is_some() {
        into.output_tokens = other.output_tokens;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_splits_records_across_chunks() {
        let mut buf = SseLineBuffer::new();
        // A record split across two pushes.
        let r1 = buf.push(b"event: content_block_delta\ndata: {\"a\":");
        assert!(r1.is_empty());
        let r2 = buf.push(b"1}\n\n");
        assert_eq!(r2.len(), 1);
        assert_eq!(r2[0].event.as_deref(), Some("content_block_delta"));
        assert_eq!(r2[0].data, "{\"a\":1}");
    }

    #[test]
    fn buffer_handles_crlf_and_multiple_records() {
        let mut buf = SseLineBuffer::new();
        let recs = buf.push(b"data: one\r\n\r\ndata: two\r\n\r\n");
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].data, "one");
        assert_eq!(recs[1].data, "two");
    }

    #[test]
    fn anthropic_text_delta() {
        let data =
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#;
        assert_eq!(
            parse_anthropic_event(Some("content_block_delta"), data),
            Some(StreamDelta::Text("Hi".into()))
        );
    }

    #[test]
    fn anthropic_ignores_thinking_and_ping() {
        let thinking =
            r#"{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"…"}}"#;
        assert_eq!(
            parse_anthropic_event(Some("content_block_delta"), thinking),
            None
        );
        assert_eq!(parse_anthropic_event(Some("ping"), "{}"), None);
    }

    #[test]
    fn anthropic_usage_and_stop() {
        let start = r#"{"type":"message_start","message":{"usage":{"input_tokens":42}}}"#;
        assert_eq!(
            parse_anthropic_event(Some("message_start"), start),
            Some(StreamDelta::Usage(Usage {
                input_tokens: Some(42),
                output_tokens: None
            }))
        );
        let delta = r#"{"type":"message_delta","delta":{},"usage":{"output_tokens":7}}"#;
        assert_eq!(
            parse_anthropic_event(Some("message_delta"), delta),
            Some(StreamDelta::Usage(Usage {
                input_tokens: None,
                output_tokens: Some(7)
            }))
        );
        assert_eq!(
            parse_anthropic_event(Some("message_stop"), "{}"),
            Some(StreamDelta::Done)
        );
    }

    #[test]
    fn anthropic_error() {
        let data = r#"{"type":"error","error":{"type":"overloaded_error","message":"busy"}}"#;
        assert_eq!(
            parse_anthropic_event(Some("error"), data),
            Some(StreamDelta::Error("busy".into()))
        );
    }

    #[test]
    fn openai_content_and_done() {
        let chunk = r#"{"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}"#;
        assert_eq!(
            parse_openai_chunk(chunk),
            Some(StreamDelta::Text("Hello".into()))
        );
        assert_eq!(parse_openai_chunk("[DONE]"), Some(StreamDelta::Done));
    }

    #[test]
    fn openai_role_only_chunk_is_ignored() {
        let chunk =
            r#"{"choices":[{"delta":{"role":"assistant"},"finish_reason":null}],"usage":null}"#;
        assert_eq!(parse_openai_chunk(chunk), None);
    }

    #[test]
    fn openai_usage_chunk() {
        let chunk = r#"{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}"#;
        assert_eq!(
            parse_openai_chunk(chunk),
            Some(StreamDelta::Usage(Usage {
                input_tokens: Some(10),
                output_tokens: Some(3)
            }))
        );
    }

    #[test]
    fn usage_merge_keeps_set_fields() {
        let mut acc = Usage::default();
        merge_usage(
            &mut acc,
            Usage {
                input_tokens: Some(10),
                output_tokens: None,
            },
        );
        merge_usage(
            &mut acc,
            Usage {
                input_tokens: None,
                output_tokens: Some(3),
            },
        );
        assert_eq!(
            acc,
            Usage {
                input_tokens: Some(10),
                output_tokens: Some(3)
            }
        );
    }
}
