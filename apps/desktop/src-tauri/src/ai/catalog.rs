//! Suggested models per provider, shown as picker hints in the settings panel.
//! The model field is free-text, so these are conveniences, not a closed set.

use novalis_core::models::{AiModelInfo, AiProviderKind};

fn info(id: &str, label: &str) -> AiModelInfo {
    AiModelInfo {
        id: id.to_string(),
        label: label.to_string(),
    }
}

pub fn models_for(kind: AiProviderKind) -> Vec<AiModelInfo> {
    match kind {
        AiProviderKind::Anthropic => vec![
            info("claude-opus-4-8", "Claude Opus 4.8"),
            info("claude-sonnet-4-6", "Claude Sonnet 4.6"),
            info("claude-haiku-4-5", "Claude Haiku 4.5"),
        ],
        AiProviderKind::OpenAiCompatible => vec![
            info("gpt-4o", "OpenAI · GPT-4o"),
            info("gpt-4o-mini", "OpenAI · GPT-4o mini"),
            info("deepseek-chat", "DeepSeek · Chat"),
            info("deepseek-reasoner", "DeepSeek · Reasoner"),
        ],
        AiProviderKind::ClaudeCli => vec![
            info("opus", "Claude Code · Opus"),
            info("sonnet", "Claude Code · Sonnet"),
            info("haiku", "Claude Code · Haiku"),
        ],
        // Suggestions only — Codex model names change often; "Default" (no
        // --model) is the safe primary and uses the tool's configured model.
        AiProviderKind::CodexCli => vec![
            info("gpt-5.5", "Codex · GPT-5.5"),
            info("gpt-5.4-mini", "Codex · GPT-5.4 mini"),
            info("gpt-5.3-codex", "Codex · GPT-5.3-codex"),
        ],
    }
}
