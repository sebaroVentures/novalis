//! The AI action registry: declarative specs plus pure prompt builders.
//!
//! Each action is an [`AiActionSpec`] (metadata only) paired with a branch in
//! [`build_messages`] that turns the note context into a [`BuiltPrompt`]. The
//! builders are pure functions so they are trivially unit-testable and reusable
//! across frontends.

use crate::error::{CoreError, CoreResult};
use crate::models::{
    AiActionView, AiContext, AiInputKind, AiInsertMode, AiScope, ChatMessage, ChatRole,
};

/// Static metadata describing one runnable action.
pub struct AiActionSpec {
    /// Stable id used by the IPC layer and the prompt-builder match.
    pub id: &'static str,
    /// Fully-namespaced i18n key (e.g. `ai:action.summarize.title`).
    pub title_key: &'static str,
    pub input: AiInputKind,
    pub scope: AiScope,
    pub insert_mode: AiInsertMode,
    /// Internal actions (not shown in the editor's action list) — e.g. the
    /// `custom` action that runs a user-defined prompt template.
    pub hidden: bool,
}

/// A system prompt plus the user/assistant turns to send to a provider.
#[derive(Debug, Clone)]
pub struct BuiltPrompt {
    pub system: String,
    pub messages: Vec<ChatMessage>,
}

/// The registry. Append a spec here (and a branch in [`build_messages`]) to add
/// an action.
const ACTIONS: &[AiActionSpec] = &[
    AiActionSpec {
        id: "summarize",
        title_key: "ai:action.summarize.title",
        input: AiInputKind::Optional,
        scope: AiScope::SelectionOrWholeNote,
        insert_mode: AiInsertMode::PanelOnly,
        hidden: false,
    },
    AiActionSpec {
        id: "compose",
        title_key: "ai:action.compose.title",
        input: AiInputKind::Required,
        scope: AiScope::WholeNote,
        insert_mode: AiInsertMode::AtCursor,
        hidden: false,
    },
    // A constructive sparring partner: pressure-tests the note's argument
    // instead of summarizing it. PanelOnly — the critique is for reading, not
    // injecting into the note. The optional input supplies a lens/persona.
    AiActionSpec {
        id: "challenge",
        title_key: "ai:action.challenge.title",
        input: AiInputKind::Optional,
        scope: AiScope::SelectionOrWholeNote,
        insert_mode: AiInsertMode::PanelOnly,
        hidden: false,
    },
    // Rewrite the selection. The result is reviewed as inline track-changes
    // (see the editor's SuggestRewrite extension), so the model must return the
    // rewritten text only. ReplaceSelection is the conceptual apply target.
    AiActionSpec {
        id: "rewrite",
        title_key: "ai:action.rewrite.title",
        input: AiInputKind::Optional,
        scope: AiScope::Selection,
        insert_mode: AiInsertMode::ReplaceSelection,
        hidden: false,
    },
    // Internal: proposes frontmatter metadata (tags / aliases / typed
    // properties) as STRICT JSON. Not a prose action, so it is hidden from the
    // editor menu; the frontmatter UI invokes it and renders the result as
    // accept/reject chips. The known-vocabulary + existing-metadata context is
    // passed as `user_input` (a JSON blob).
    AiActionSpec {
        id: "suggest-meta",
        title_key: "",
        input: AiInputKind::Optional,
        scope: AiScope::WholeNote,
        insert_mode: AiInsertMode::PanelOnly,
        hidden: true,
    },
    // Internal: the vehicle for user-defined prompt templates. The template
    // body is passed as the instruction (user_input); not shown in the menu.
    AiActionSpec {
        id: "custom",
        title_key: "",
        input: AiInputKind::Required,
        scope: AiScope::SelectionOrWholeNote,
        insert_mode: AiInsertMode::PanelOnly,
        hidden: true,
    },
];

/// All registered actions.
pub fn actions() -> &'static [AiActionSpec] {
    ACTIONS
}

/// Look up an action spec by id.
pub fn action(id: &str) -> Option<&'static AiActionSpec> {
    ACTIONS.iter().find(|a| a.id == id)
}

/// Serializable views of the user-facing actions, for the editor picker.
pub fn action_views() -> Vec<AiActionView> {
    ACTIONS
        .iter()
        .filter(|a| !a.hidden)
        .map(|a| AiActionView {
            id: a.id.to_string(),
            title_key: a.title_key.to_string(),
            input: a.input,
            scope: a.scope,
            insert_mode: a.insert_mode,
        })
        .collect()
}

/// Build the prompt for `action_id` from the note context and optional user
/// instruction. Pure; no IO.
pub fn build_messages(
    action_id: &str,
    ctx: &AiContext,
    user_input: Option<&str>,
) -> CoreResult<BuiltPrompt> {
    let spec =
        action(action_id).ok_or_else(|| CoreError::BadRequest(format!("unknown AI action: {action_id}")))?;

    let user_input = user_input.map(str::trim).filter(|s| !s.is_empty());
    if spec.input == AiInputKind::Required && user_input.is_none() {
        return Err(CoreError::BadRequest(
            "this action needs an instruction".into(),
        ));
    }

    let body = resolve_scope(spec.scope, ctx);

    match spec.id {
        "summarize" => {
            if body.trim().is_empty() {
                return Err(CoreError::BadRequest(
                    "nothing to send: the note (or selection) is empty".into(),
                ));
            }
            Ok(summarize_prompt(ctx, &body, user_input))
        }
        // The instruction is the task; the note is optional context.
        "compose" => Ok(compose_prompt(ctx, &body, user_input.unwrap_or_default())),
        "challenge" => {
            if body.trim().is_empty() {
                return Err(CoreError::BadRequest(
                    "nothing to challenge: the note (or selection) is empty".into(),
                ));
            }
            Ok(challenge_prompt(ctx, &body, user_input))
        }
        "rewrite" => {
            if body.trim().is_empty() {
                return Err(CoreError::BadRequest(
                    "nothing to rewrite: select some text first".into(),
                ));
            }
            Ok(rewrite_prompt(&body, user_input))
        }
        "suggest-meta" => {
            if body.trim().is_empty() {
                return Err(CoreError::BadRequest(
                    "nothing to analyze: the note is empty".into(),
                ));
            }
            Ok(suggest_meta_prompt(ctx, &body, user_input))
        }
        // A user-defined prompt template: the template body is the instruction,
        // applied to the note/selection (which may be empty).
        "custom" => Ok(custom_prompt(ctx, &body, user_input.unwrap_or_default())),
        other => Err(CoreError::BadRequest(format!(
            "AI action not implemented: {other}"
        ))),
    }
}

/// Resolve the working text an action operates on from its scope.
fn resolve_scope(scope: AiScope, ctx: &AiContext) -> String {
    match scope {
        AiScope::WholeNote => ctx.markdown.clone(),
        AiScope::Selection => ctx.selection.clone().unwrap_or_default(),
        AiScope::SelectionOrWholeNote => match ctx.selection.as_deref() {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => ctx.markdown.clone(),
        },
    }
}

/// Prepend the note title and any extra instruction to the working body.
fn user_message(ctx: &AiContext, body: &str, user_input: Option<&str>) -> String {
    let mut out = String::new();
    let title = ctx.title.trim();
    if !title.is_empty() {
        out.push_str("Note title: ");
        out.push_str(title);
        out.push_str("\n\n");
    }
    if let Some(extra) = user_input.map(str::trim).filter(|s| !s.is_empty()) {
        out.push_str("Additional instruction: ");
        out.push_str(extra);
        out.push_str("\n\n");
    }
    out.push_str("Note content:\n\n");
    out.push_str(body);
    out
}

fn summarize_prompt(ctx: &AiContext, body: &str, user_input: Option<&str>) -> BuiltPrompt {
    let system = "You are a careful writing assistant embedded in a note-taking app. \
Produce a clear, well-structured summary of the user's note in Markdown. \
Lead with a one- or two-sentence overview, then the key points as a concise bullet list, \
and finish with action items or open questions only if the note contains them (omit empty sections). \
Preserve important names, dates, numbers, and decisions. Write in the same language as the note. \
Output only the summary — no preamble and no meta commentary."
        .to_string();

    BuiltPrompt {
        system,
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: user_message(ctx, body, user_input),
        }],
    }
}

fn compose_prompt(ctx: &AiContext, body: &str, instruction: &str) -> BuiltPrompt {
    let system = "You are a helpful writing assistant embedded in a note-taking app. \
Write Markdown content that fulfills the user's request, using any existing note content only as context. \
Output only the requested content — no preamble, no surrounding explanation, and no code fences unless the content itself is code. \
Match the language of the request and the existing note."
        .to_string();

    let mut user = String::new();
    let title = ctx.title.trim();
    if !title.is_empty() {
        user.push_str("Note title: ");
        user.push_str(title);
        user.push_str("\n\n");
    }
    user.push_str("Request: ");
    user.push_str(instruction);
    if !body.trim().is_empty() {
        user.push_str("\n\nExisting note content (context):\n\n");
        user.push_str(body);
    }

    BuiltPrompt {
        system,
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: user,
        }],
    }
}

fn challenge_prompt(ctx: &AiContext, body: &str, user_input: Option<&str>) -> BuiltPrompt {
    let system = "You are a sharp, constructive intellectual sparring partner embedded in a note-taking app. \
The user wants their thinking pressure-tested — not summarized, not praised. \
Read the note (or selection) and surface, as a concise Markdown list, the points most worth defending: \
the weakest or least-supported claims, unstated assumptions, missing counterarguments, and logical leaps. \
For each point, first quote the exact phrase or sentence you are challenging in double quotes so the user can locate it, \
then explain the concern in one or two sentences, and where useful pose one probing question. \
Be specific, rigorous, and fair; never invent claims that are not in the text. \
If the user supplied a lens or persona to argue from, adopt it. \
Write in the same language as the note. \
Output only the critique — no preamble, no restatement of the note, and no closing praise."
        .to_string();

    BuiltPrompt {
        system,
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: user_message(ctx, body, user_input),
        }],
    }
}

fn rewrite_prompt(body: &str, user_input: Option<&str>) -> BuiltPrompt {
    let system = "You are a precise text-editing assistant embedded in a note-taking app. \
Rewrite ONLY the user's selected text and return ONLY the rewritten version — \
no preamble, no quotation marks around the whole answer, no surrounding explanation, \
and no Markdown code fences unless the selection itself is code. \
Preserve the original meaning, key facts, names, and any inline Markdown formatting unless the instruction says otherwise. \
If the user gave an instruction (for example: make it more concise, or change the tone), apply it faithfully. \
Keep the result able to stand in place of the selection. \
Write in the same language as the selection."
        .to_string();

    let mut user = String::new();
    if let Some(extra) = user_input.map(str::trim).filter(|s| !s.is_empty()) {
        user.push_str("Instruction: ");
        user.push_str(extra);
        user.push_str("\n\n");
    }
    user.push_str("Selected text:\n\n");
    user.push_str(body);

    BuiltPrompt {
        system,
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: user,
        }],
    }
}

fn suggest_meta_prompt(ctx: &AiContext, body: &str, user_input: Option<&str>) -> BuiltPrompt {
    let system = "You are a metadata assistant for a Markdown note app. Analyze the note and propose frontmatter metadata. \
Respond with STRICT JSON ONLY — no prose, no explanation, no code fences — matching exactly this shape: \
{\"tags\":[\"tag\"],\"aliases\":[\"Alias\"],\"properties\":[{\"key\":\"status\",\"kind\":\"text\",\"value\":\"active\"}]}. \
Rules: tags are lowercase and hyphenated with no leading '#'; PREFER tags from the provided knownTags list when they fit, \
inventing a new tag only when clearly warranted. \
Never repeat tags or aliases the note already has, nor property keys it already has (see existingTags / existingAliases / existingPropertyKeys). \
Aliases are alternative titles a person might search for. \
Properties are typed: use \"checkbox\" for booleans, \"number\" for numeric values, \"list\" for arrays of short strings, otherwise \"text\". \
Propose only high-confidence, genuinely useful metadata — a handful at most. If nothing is worth adding, return empty arrays. \
Output JSON only."
        .to_string();

    let mut user = String::new();
    let title = ctx.title.trim();
    if !title.is_empty() {
        user.push_str("Note title: ");
        user.push_str(title);
        user.push_str("\n\n");
    }
    if let Some(vocab) = user_input.map(str::trim).filter(|s| !s.is_empty()) {
        user.push_str("Known vocabulary and existing metadata (JSON):\n");
        user.push_str(vocab);
        user.push_str("\n\n");
    }
    user.push_str("Note content:\n\n");
    user.push_str(body);

    BuiltPrompt {
        system,
        messages: vec![ChatMessage {
            role: ChatRole::User,
            content: user,
        }],
    }
}

fn custom_prompt(ctx: &AiContext, body: &str, instruction: &str) -> BuiltPrompt {
    let system = "You are a writing assistant embedded in a note-taking app. \
Apply the user's instruction to the provided note content (or selection). \
Output only the resulting Markdown — no preamble, no explanation, and no code fences unless the content itself is code. \
Match the language implied by the instruction and the content."
        .to_string();

    let mut user = String::new();
    let title = ctx.title.trim();
    if !title.is_empty() {
        user.push_str("Note title: ");
        user.push_str(title);
        user.push_str("\n\n");
    }
    user.push_str("Instruction:\n");
    user.push_str(instruction);
    if !body.trim().is_empty() {
        user.push_str("\n\nContent:\n\n");
        user.push_str(body);
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

    fn ctx(markdown: &str, selection: Option<&str>) -> AiContext {
        AiContext {
            title: "My Note".into(),
            markdown: markdown.into(),
            selection: selection.map(str::to_string),
        }
    }

    #[test]
    fn registry_exposes_summarize() {
        assert!(action("summarize").is_some());
        assert!(action_views().iter().any(|a| a.id == "summarize"));
    }

    #[test]
    fn summarize_builds_a_prompt_containing_the_note() {
        let p = build_messages("summarize", &ctx("Hello world body", None), None).unwrap();
        assert!(!p.system.trim().is_empty());
        assert_eq!(p.messages.len(), 1);
        assert_eq!(p.messages[0].role, ChatRole::User);
        assert!(p.messages[0].content.contains("Hello world body"));
        assert!(p.messages[0].content.contains("My Note"));
    }

    #[test]
    fn summarize_prefers_selection_when_present() {
        let p = build_messages(
            "summarize",
            &ctx("Whole note text", Some("Just this part")),
            None,
        )
        .unwrap();
        assert!(p.messages[0].content.contains("Just this part"));
        assert!(!p.messages[0].content.contains("Whole note text"));
    }

    #[test]
    fn summarize_includes_extra_instruction() {
        let p = build_messages("summarize", &ctx("Body", None), Some("in German")).unwrap();
        assert!(p.messages[0].content.contains("in German"));
    }

    #[test]
    fn unknown_action_is_a_bad_request() {
        let err = build_messages("nope", &ctx("Body", None), None).unwrap_err();
        assert!(matches!(err, CoreError::BadRequest(_)));
    }

    #[test]
    fn empty_note_is_rejected() {
        let err = build_messages("summarize", &ctx("   \n  ", None), None).unwrap_err();
        assert!(matches!(err, CoreError::BadRequest(_)));
    }

    #[test]
    fn compose_requires_an_instruction() {
        let err = build_messages("compose", &ctx("Some context", None), None).unwrap_err();
        assert!(matches!(err, CoreError::BadRequest(_)));
    }

    #[test]
    fn compose_builds_a_prompt_from_the_instruction() {
        let p = build_messages(
            "compose",
            &ctx("Existing body", None),
            Some("write an intro paragraph"),
        )
        .unwrap();
        assert!(!p.system.trim().is_empty());
        assert!(p.messages[0].content.contains("write an intro paragraph"));
        assert!(p.messages[0].content.contains("Existing body"));
    }

    #[test]
    fn compose_works_on_an_empty_note() {
        // The instruction is the task; an empty note (new note) is fine.
        let p = build_messages("compose", &ctx("", None), Some("draft a haiku")).unwrap();
        assert!(p.messages[0].content.contains("draft a haiku"));
    }

    #[test]
    fn custom_action_is_hidden_from_views() {
        assert!(action("custom").is_some(), "exists in the registry");
        assert!(
            !action_views().iter().any(|a| a.id == "custom"),
            "but is not shown in the editor picker"
        );
    }

    #[test]
    fn custom_applies_the_template_body_to_the_note() {
        let p = build_messages(
            "custom",
            &ctx("Hello world", None),
            Some("Translate to German"),
        )
        .unwrap();
        assert!(p.messages[0].content.contains("Translate to German"));
        assert!(p.messages[0].content.contains("Hello world"));
    }

    #[test]
    fn custom_requires_a_template_body() {
        let err = build_messages("custom", &ctx("Hello", None), None).unwrap_err();
        assert!(matches!(err, CoreError::BadRequest(_)));
    }

    #[test]
    fn challenge_is_listed_in_views() {
        assert!(action("challenge").is_some());
        assert!(action_views().iter().any(|a| a.id == "challenge"));
    }

    #[test]
    fn challenge_builds_a_prompt_over_the_note() {
        let p = build_messages("challenge", &ctx("My thesis is X because Y", None), None).unwrap();
        assert!(!p.system.trim().is_empty());
        assert_eq!(p.messages.len(), 1);
        assert!(p.messages[0].content.contains("My thesis is X because Y"));
    }

    #[test]
    fn challenge_prefers_selection_and_accepts_a_lens() {
        let p = build_messages(
            "challenge",
            &ctx("Whole note", Some("Just this claim")),
            Some("argue as a skeptical economist"),
        )
        .unwrap();
        assert!(p.messages[0].content.contains("Just this claim"));
        assert!(!p.messages[0].content.contains("Whole note"));
        assert!(p.messages[0].content.contains("skeptical economist"));
    }

    #[test]
    fn challenge_rejects_an_empty_note() {
        let err = build_messages("challenge", &ctx("   \n ", None), None).unwrap_err();
        assert!(matches!(err, CoreError::BadRequest(_)));
    }

    #[test]
    fn rewrite_is_listed_in_views() {
        assert!(action("rewrite").is_some());
        assert!(action_views().iter().any(|a| a.id == "rewrite"));
    }

    #[test]
    fn rewrite_operates_on_the_selection_and_takes_an_instruction() {
        let p = build_messages(
            "rewrite",
            &ctx("the whole note", Some("the chosen sentence")),
            Some("make it more concise"),
        )
        .unwrap();
        assert!(p.messages[0].content.contains("the chosen sentence"));
        assert!(p.messages[0].content.contains("make it more concise"));
        // Scope is Selection only: the rest of the note must not leak in.
        assert!(!p.messages[0].content.contains("the whole note"));
    }

    #[test]
    fn rewrite_requires_a_selection() {
        // No selection → Selection scope resolves to empty → rejected.
        let err = build_messages("rewrite", &ctx("note body", None), None).unwrap_err();
        assert!(matches!(err, CoreError::BadRequest(_)));
    }

    #[test]
    fn suggest_meta_exists_but_is_hidden() {
        assert!(action("suggest-meta").is_some());
        assert!(!action_views().iter().any(|a| a.id == "suggest-meta"));
    }

    #[test]
    fn suggest_meta_builds_a_prompt_with_body_and_vocabulary() {
        let p = build_messages(
            "suggest-meta",
            &ctx("A note about Rust ownership", None),
            Some("{\"knownTags\":[\"rust\",\"memory\"],\"existingTags\":[\"draft\"]}"),
        )
        .unwrap();
        assert!(p.system.contains("JSON"));
        assert!(p.messages[0].content.contains("A note about Rust ownership"));
        assert!(p.messages[0].content.contains("knownTags"));
    }

    #[test]
    fn suggest_meta_rejects_an_empty_note() {
        let err = build_messages("suggest-meta", &ctx("   ", None), None).unwrap_err();
        assert!(matches!(err, CoreError::BadRequest(_)));
    }
}
