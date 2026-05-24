//! YAML frontmatter parsing and serialization.
//!
//! Novalis writes YAML frontmatter exclusively (decision #7) for Obsidian
//! compatibility. Reading is currently YAML-only; migration of legacy formats
//! (Logseq `key:: value`, TOML `+++`) is a tracked follow-up.

use chrono::Utc;
use gray_matter::engine::YAML;
use gray_matter::Matter;

use crate::models::NoteFrontmatter;

/// Parse YAML frontmatter from a markdown string.
/// Returns the parsed frontmatter and the body (content after frontmatter).
pub fn parse_frontmatter(content: &str) -> (NoteFrontmatter, String) {
    let matter = Matter::<YAML>::new();
    let result = matter.parse(content);

    let fm: NoteFrontmatter = if let Some(data) = result.data {
        match data.deserialize() {
            Ok(fm) => fm,
            Err(e) => {
                log::warn!("failed to deserialize frontmatter: {e}");
                NoteFrontmatter::default()
            }
        }
    } else {
        NoteFrontmatter::default()
    };

    (fm, result.content)
}

/// Serialize frontmatter and body back into markdown with YAML front matter.
pub fn serialize_frontmatter(fm: &NoteFrontmatter, body: &str) -> String {
    let yaml = serde_yaml::to_string(fm).unwrap_or_default();
    // serde_yaml adds a trailing newline; trim it for cleanliness.
    let yaml = yaml.trim_end();
    format!("---\n{yaml}\n---\n{body}")
}

/// Update the `modified` field in frontmatter to the current UTC time.
pub fn update_modified(content: &str) -> String {
    let (mut fm, body) = parse_frontmatter(content);
    fm.modified = Utc::now().to_rfc3339();
    serialize_frontmatter(&fm, &body)
}

/// Extract a display title from frontmatter, first H1 heading, or filename.
pub fn extract_title(fm: &NoteFrontmatter, body: &str, filename: &str) -> String {
    // 1. Title from frontmatter
    if let Some(ref t) = fm.title {
        if !t.is_empty() {
            return t.clone();
        }
    }

    // 2. First H1 heading in body
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(heading) = trimmed.strip_prefix("# ") {
            let heading = heading.trim();
            if !heading.is_empty() {
                return heading.to_string();
            }
        }
    }

    // 3. Filename without extension
    filename.strip_suffix(".md").unwrap_or(filename).to_string()
}

/// Count words in a string (body text).
pub fn word_count(text: &str) -> usize {
    text.split_whitespace().count()
}
