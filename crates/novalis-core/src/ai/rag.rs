//! "Chat with your vault" (RAG): the *pure* half of hybrid retrieval and the
//! grounded-answer prompt builder. No DB, no IO, no network — the desktop shell
//! embeds the question, runs FTS ([`crate::index::search::search`]) and the
//! vector ANN ([`crate::index::vectors::retrieve_related`], both reused as-is),
//! and feeds their ranked note lists here to *fuse*; then builds the prompt and
//! streams the answer over the existing `ai-stream-*` events.
//!
//! ## Why fuse, not concatenate
//!
//! FTS (keyword) and vector (semantic) retrieval each miss what the other
//! catches: FTS nails exact names/numbers a paraphrase-embedding blurs; vectors
//! catch a question worded nothing like the note. Reciprocal-rank fusion
//! ([`reciprocal_rank_fusion`]) blends the two *rank* orders — score-scale
//! agnostic, so an FTS `rank` and a cosine score never have to be comparable —
//! into one list, which then feeds the top-K passages the model sees.
//!
//! ## Grounding + honest empties
//!
//! [`build_rag_prompt`] instructs the model to answer ONLY from the supplied
//! passages and cite each claim as `[[n]]` (a passage number the frontend
//! resolves to a note + offset), and to say it couldn't find the answer rather
//! than invent one. Truly *empty* retrieval never reaches the model at all — the
//! command short-circuits to the honest "not in your notes" message, so a
//! provider can't hallucinate over zero context.

use crate::ai::BuiltPrompt;
use crate::models::{ChatMessage, ChatRole, RagCitation};

/// Reciprocal-rank-fusion damping constant. 60 is the value from Cormack et
/// al.'s original RRF paper and the common default: large enough that no single
/// list's top hit dominates the blend, small enough that rank still matters.
pub const RRF_K: f64 = 60.0;

/// Default number of passages retrieved, cited, and fed to the model. A handful
/// — enough context to answer most questions, few enough to keep the prompt
/// (and the citation list the user scans) tight.
pub const DEFAULT_TOP_K: usize = 6;

/// Minimum length of a keyword kept from the question (shorter tokens are
/// almost all stopwords/noise and would drag in low-precision FTS hits).
const MIN_KEYWORD_LEN: usize = 3;

/// Cap on distinct keywords extracted from one question — bounds the number of
/// per-term FTS queries the command runs under the engine lock.
const MAX_KEYWORDS: usize = 8;

/// One fused, ranked key (a note path) with its combined RRF score.
#[derive(Debug, Clone, PartialEq)]
pub struct FusedHit {
    pub key: String,
    pub score: f64,
}

/// Fuse several ranked lists of keys (each best-first) into one ranking via
/// reciprocal-rank fusion: a key's score is `Σ 1/(RRF_K + rank)` over the lists
/// it appears in (0-based rank; only the first occurrence within a list counts).
/// Returns keys sorted by score descending, ties broken by key ascending for
/// determinism. Empty lists contribute nothing; an all-empty input yields `[]`.
pub fn reciprocal_rank_fusion(lists: &[Vec<String>]) -> Vec<FusedHit> {
    use std::collections::HashMap;
    let mut scores: HashMap<&str, f64> = HashMap::new();
    for list in lists {
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for (rank, key) in list.iter().enumerate() {
            if !seen.insert(key.as_str()) {
                continue; // count a key once per list (its best rank)
            }
            *scores.entry(key.as_str()).or_insert(0.0) += 1.0 / (RRF_K + rank as f64);
        }
    }
    let mut out: Vec<FusedHit> = scores
        .into_iter()
        .map(|(key, score)| FusedHit {
            key: key.to_string(),
            score,
        })
        .collect();
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.key.cmp(&b.key))
    });
    out
}

/// Extract salient keywords from a natural-language question for the FTS half of
/// retrieval: lowercase, split on non-alphanumeric boundaries, drop very short
/// tokens and common English stopwords, de-duplicate (preserving first-seen
/// order), and cap at [`MAX_KEYWORDS`]. Pure. Non-English stopwords aren't
/// filtered — they simply become extra keyword terms, which FTS tolerates.
pub fn keywords(question: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in question.split(|c: char| !c.is_alphanumeric()) {
        if out.len() >= MAX_KEYWORDS {
            break;
        }
        let tok = raw.to_lowercase();
        if tok.chars().count() < MIN_KEYWORD_LEN || is_stopword(&tok) {
            continue;
        }
        if !out.iter().any(|k| k == &tok) {
            out.push(tok);
        }
    }
    out
}

/// A small English stopword set — the highest-frequency function words that add
/// FTS noise without narrowing a search. Intentionally short: over-filtering
/// would strip real query terms.
fn is_stopword(tok: &str) -> bool {
    const STOP: &[&str] = &[
        "the", "and", "for", "are", "was", "were", "with", "that", "this", "have", "has", "had",
        "from", "what", "when", "where", "which", "who", "why", "how", "does", "did", "will",
        "would", "could", "should", "about", "into", "your", "you", "our", "their", "there",
        "then", "than", "them", "they", "not", "but", "any", "all", "can", "get", "got", "out",
    ];
    STOP.contains(&tok)
}

/// Slice a character span out of `source` (char — not byte — offsets, matching
/// the offsets stored on a chunk row against the note's truncated embed text).
/// Out-of-range or inverted spans clamp to a valid, possibly-empty slice rather
/// than panicking. Pure.
pub fn passage_slice(source: &str, char_start: u32, char_end: u32) -> String {
    let start = char_start as usize;
    let end = char_end as usize;
    if end <= start {
        return String::new();
    }
    source.chars().skip(start).take(end - start).collect()
}

/// Strip the `<mark>…</mark>` highlight tags an FTS5 `snippet()` wraps matched
/// terms in, leaving readable plain text for the prompt + citation preview. The
/// `…` ellipsis FTS inserts at snippet edges is kept (it reads as truncation).
pub fn strip_fts_marks(snippet: &str) -> String {
    snippet.replace("<mark>", "").replace("</mark>", "")
}

/// The exact citation token the model is told to emit and the frontend resolves
/// to a note+offset: `[[1]]`, `[[2]]`, … (1-based passage number).
pub fn format_citation(id: u32) -> String {
    format!("[[{id}]]")
}

/// Build the grounded-answer prompt: a system prompt that pins the model to the
/// supplied passages + the `[[n]]` citation form + the honest-empty fallback,
/// and a user turn carrying the question and every numbered passage. Pure.
pub fn build_rag_prompt(question: &str, passages: &[RagCitation]) -> BuiltPrompt {
    let system = "You are a research assistant answering questions strictly from the user's own notes. \
You are given numbered passages retrieved from their personal note vault. \
Answer the question using ONLY the information in these passages — never rely on outside knowledge, and never invent facts. \
After each claim, cite the passage it comes from using the EXACT form [[1]] (use [[1]][[2]] when a claim draws on several). \
Cite only passage numbers listed below; never cite a number that is not present. \
If the passages do not contain enough information to answer the question, reply with exactly: \"I couldn't find that in your notes.\" and nothing else. \
Answer in the same language as the question. Be concise and factual, and do not repeat the passages verbatim."
        .to_string();

    let mut user = String::new();
    user.push_str("Question: ");
    user.push_str(question.trim());
    user.push_str("\n\nPassages:\n");
    for p in passages {
        user.push('\n');
        user.push_str(&format_citation(p.id));
        user.push(' ');
        user.push_str(p.title.trim());
        user.push('\n');
        user.push_str(p.snippet.trim());
        user.push('\n');
    }

    BuiltPrompt {
        system,
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: user,
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn citation(id: u32, path: &str, title: &str, snippet: &str) -> RagCitation {
        RagCitation {
            id,
            path: path.into(),
            title: title.into(),
            char_start: 0,
            char_end: 0,
            snippet: snippet.into(),
        }
    }

    // --- reciprocal-rank fusion ------------------------------------------

    #[test]
    fn rrf_ranks_a_key_present_in_both_lists_first() {
        // "b" is mid-pack in each list but appears in both, so its summed
        // reciprocal ranks beat either list's lone top hit.
        let fts = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let vec = vec!["d".to_string(), "b".to_string(), "e".to_string()];
        let fused = reciprocal_rank_fusion(&[fts, vec]);
        assert_eq!(fused[0].key, "b", "consensus hit leads");
        // Every input key survives the fusion.
        assert_eq!(fused.len(), 5);
    }

    #[test]
    fn rrf_rank_position_matters() {
        // Same two keys, but "x" is rank-0 in both lists and "y" rank-1 in both.
        let l1 = vec!["x".to_string(), "y".to_string()];
        let l2 = vec!["x".to_string(), "y".to_string()];
        let fused = reciprocal_rank_fusion(&[l1, l2]);
        assert_eq!(fused[0].key, "x");
        assert_eq!(fused[1].key, "y");
        assert!(fused[0].score > fused[1].score);
    }

    #[test]
    fn rrf_counts_a_key_once_per_list_and_breaks_ties_by_key() {
        // A duplicate within one list must not double-score. Two keys tied on
        // score fall back to lexicographic order.
        let l1 = vec!["z".to_string(), "z".to_string(), "a".to_string()];
        let fused = reciprocal_rank_fusion(&[l1]);
        // z at rank 0 outranks a at rank 2; the duplicate z is ignored.
        assert_eq!(fused[0].key, "z");
        assert_eq!(fused[1].key, "a");
        // A genuine tie (two singleton lists, each one rank-0 key) → key order.
        let tie = reciprocal_rank_fusion(&[vec!["m".to_string()], vec!["c".to_string()]]);
        assert_eq!(tie[0].key, "c");
        assert_eq!(tie[1].key, "m");
    }

    #[test]
    fn rrf_handles_empty_and_all_empty_inputs() {
        assert!(reciprocal_rank_fusion(&[]).is_empty());
        assert!(reciprocal_rank_fusion(&[vec![], vec![]]).is_empty());
        // An empty list alongside a populated one contributes nothing but doesn't
        // drop the populated list's keys.
        let fused = reciprocal_rank_fusion(&[vec![], vec!["a".to_string()]]);
        assert_eq!(fused.len(), 1);
        assert_eq!(fused[0].key, "a");
    }

    // --- keyword extraction ----------------------------------------------

    #[test]
    fn keywords_drops_stopwords_and_short_tokens_and_dedupes() {
        let kws = keywords("What did I decide about the launch date and the launch budget?");
        // Stopwords (what/did/the/and/about) and short tokens (I) are gone;
        // "launch" appears once despite two mentions.
        assert!(kws.contains(&"launch".to_string()));
        assert!(kws.contains(&"decide".to_string()));
        assert!(kws.contains(&"budget".to_string()));
        assert!(!kws.contains(&"the".to_string()));
        assert!(!kws.contains(&"what".to_string()));
        assert_eq!(kws.iter().filter(|k| *k == "launch").count(), 1);
    }

    #[test]
    fn keywords_is_empty_for_an_all_stopword_question() {
        assert!(keywords("what did you do?").is_empty());
        assert!(keywords("   ").is_empty());
    }

    #[test]
    fn keywords_are_capped() {
        let q = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
        assert!(keywords(q).len() <= MAX_KEYWORDS);
    }

    // --- passage slicing + snippet cleanup -------------------------------

    #[test]
    fn passage_slice_is_char_safe_and_clamps() {
        let s = "😀abcdef";
        // Char offsets, not bytes: skip the 4-byte emoji, take "abc".
        assert_eq!(passage_slice(s, 1, 4), "abc");
        // Out-of-range end clamps to the string end (no panic).
        assert_eq!(passage_slice(s, 1, 999), "abcdef");
        // Inverted / empty spans yield "".
        assert_eq!(passage_slice(s, 5, 5), "");
        assert_eq!(passage_slice(s, 9, 2), "");
    }

    #[test]
    fn strip_fts_marks_removes_only_the_highlight_tags() {
        assert_eq!(
            strip_fts_marks("…the <mark>launch</mark> date is <mark>Friday</mark>…"),
            "…the launch date is Friday…"
        );
    }

    #[test]
    fn format_citation_is_the_double_bracket_number() {
        assert_eq!(format_citation(1), "[[1]]");
        assert_eq!(format_citation(42), "[[42]]");
    }

    // --- prompt builder ---------------------------------------------------

    #[test]
    fn build_rag_prompt_grounds_cites_and_carries_every_passage() {
        let passages = vec![
            citation(
                1,
                "notes/a.md",
                "Launch Plan",
                "The launch is set for Friday.",
            ),
            citation(2, "notes/b.md", "Budget", "The budget is fifty thousand."),
        ];
        let p = build_rag_prompt("When is the launch?", &passages);
        // System prompt pins grounding, the [[n]] form, and the honest fallback.
        assert!(p.system.contains("ONLY"));
        assert!(p.system.contains("[[1]]"));
        assert!(p.system.contains("I couldn't find that in your notes."));
        // User turn carries the question and every numbered passage + its text.
        assert_eq!(p.messages.len(), 1);
        assert_eq!(p.messages[0].role, ChatRole::User);
        let u = &p.messages[0].content;
        assert!(u.contains("When is the launch?"));
        assert!(u.contains("[[1]] Launch Plan"));
        assert!(u.contains("The launch is set for Friday."));
        assert!(u.contains("[[2]] Budget"));
        assert!(u.contains("The budget is fifty thousand."));
    }

    #[test]
    fn build_rag_prompt_tolerates_no_passages() {
        // Defensive: the command short-circuits empty retrieval before ever
        // calling this, but an empty passage list must still build a valid prompt.
        let p = build_rag_prompt("anything?", &[]);
        assert!(p.messages[0].content.contains("anything?"));
        assert!(p.system.contains("I couldn't find that in your notes."));
    }
}
