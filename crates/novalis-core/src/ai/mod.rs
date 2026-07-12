//! AI/LLM domain layer: the extensible action registry and a provider-agnostic
//! streaming parser. This module is pure — no HTTP, keychain, or process work
//! (those live in the desktop shell). Shared DTOs are in [`crate::models::ai`].
//!
//! Adding a new action is intentionally local: append an [`AiActionSpec`] to the
//! registry in [`action`] and add a prompt branch in [`action::build_messages`].
//! No provider, command, or UI code needs to change.

pub mod action;
pub mod rag;
pub mod sse;

pub use action::{action, action_views, actions, build_messages, AiActionSpec, BuiltPrompt};
pub use rag::{
    build_rag_prompt, format_citation, keywords, passage_slice, reciprocal_rank_fusion,
    strip_fts_marks, FusedHit,
};
pub use sse::{
    merge_usage, parse_anthropic_event, parse_openai_chunk, SseLineBuffer, SseRecord, StreamDelta,
};
