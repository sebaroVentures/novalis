//! YAML frontmatter parsing and serialization.
//!
//! Novalis writes YAML frontmatter exclusively (decision #7) for Obsidian
//! compatibility. Reading is currently YAML-only; migration of legacy formats
//! (Logseq `key:: value`, TOML `+++`) is a tracked follow-up.

use std::sync::OnceLock;

use chrono::Utc;
use gray_matter::engine::YAML;
use gray_matter::Matter;
use regex::Regex;

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

/// Extract inline `#tag` references from a note body, preserving first-seen
/// order. Tags allow nesting (`#area/work`) and hyphens (`#in-progress`) and are
/// returned verbatim (without the leading `#`, no case folding) for parity with
/// frontmatter tags. ATX headings, fenced code blocks, and inline code spans are
/// skipped so a `#` in any of those isn't mistaken for a tag.
///
/// Expects the note *body* (post-frontmatter), as returned by
/// [`parse_frontmatter`].
pub fn extract_body_tags(body: &str) -> Vec<String> {
    // A tag is `#` + an alnum/underscore lead, then word chars plus `/` and `-`.
    // The `(?:^|[^\w/#])` guard keeps `a#b`, `path/#x`, and `##` from matching
    // mid-token. Group 1 is the tag text without the `#`.
    static TAG_RE: OnceLock<Regex> = OnceLock::new();
    static HEADING_RE: OnceLock<Regex> = OnceLock::new();
    static INLINE_CODE_RE: OnceLock<Regex> = OnceLock::new();
    let tag_re = TAG_RE.get_or_init(|| Regex::new(r"(?:^|[^\w/#])#([A-Za-z0-9_][\w/-]*)").unwrap());
    let heading_re = HEADING_RE.get_or_init(|| Regex::new(r"^ {0,3}#{1,6}\s+").unwrap());
    let inline_code_re = INLINE_CODE_RE.get_or_init(|| Regex::new(r"`[^`]*`").unwrap());

    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let mut in_code_fence = false;

    for line in body.lines() {
        let fence = line.trim_start();
        if fence.starts_with("```") || fence.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence || heading_re.is_match(line) {
            continue;
        }
        // Blank out inline code spans so a `#` inside backticks isn't a tag.
        let scrubbed = inline_code_re.replace_all(line, " ");
        for caps in tag_re.captures_iter(&scrubbed) {
            let tag = caps.get(1).unwrap().as_str().to_string();
            if seen.insert(tag.clone()) {
                out.push(tag);
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_body_tags_basic_and_nested() {
        assert_eq!(
            extract_body_tags("see #project/alpha and #in-progress now"),
            vec!["project/alpha".to_string(), "in-progress".to_string()]
        );
    }

    #[test]
    fn extract_body_tags_skips_code_and_headings_and_midword() {
        let body =
            "# Heading #notatag\n\nreal #keep here\n\n`#incode` and a#b\n\n```\n#fenced\n```\n";
        assert_eq!(extract_body_tags(body), vec!["keep".to_string()]);
    }

    #[test]
    fn extract_body_tags_dedupes_preserving_order() {
        assert_eq!(
            extract_body_tags("#x and #y then #x again"),
            vec!["x".to_string(), "y".to_string()]
        );
    }

    #[test]
    fn extract_body_tags_ignores_bare_hash() {
        assert_eq!(
            extract_body_tags("just a # and ## with spaces"),
            Vec::<String>::new()
        );
    }
}
