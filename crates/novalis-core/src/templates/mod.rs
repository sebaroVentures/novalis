//! Note templates, stored as JSON files in `<data_dir>/templates/`.

use std::path::Path;
use std::sync::OnceLock;

use chrono::{Local, Utc};
use regex::Regex;
use uuid::Uuid;

use crate::error::{CoreError, CoreResult};
use crate::models::NoteTemplate;

fn templates_dir(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("templates")
}

/// Substitution context for [`render_template`].
#[derive(Debug, Default, Clone)]
pub struct TemplateContext {
    /// The new note's title (its filename stem), for `{{title}}`.
    pub title: Option<String>,
}

/// Render `{{...}}` variables in a template against `ctx` and the current local
/// time. Supported tokens:
/// - `{{title}}` — the note title (empty if none)
/// - `{{date}}` — `YYYY-MM-DD`
/// - `{{date:FMT}}` — `FMT` as a chrono/strftime format
/// - `{{time}}` — `HH:MM`
///
/// Unknown variables and invalid date formats are left **untouched** (no silent
/// data loss). All time-based tokens in one render share a single `now`, so they
/// stay internally consistent.
pub fn render_template(content: &str, ctx: &TemplateContext) -> String {
    static VAR_RE: OnceLock<Regex> = OnceLock::new();
    let var_re =
        VAR_RE.get_or_init(|| Regex::new(r"\{\{\s*([a-zA-Z]+)(?::([^}]*))?\s*\}\}").unwrap());

    let now = Local::now();
    var_re
        .replace_all(content, |caps: &regex::Captures| {
            let name = &caps[1];
            let arg = caps.get(2).map(|m| m.as_str());
            match (name, arg) {
                ("title", _) => ctx.title.clone().unwrap_or_default(),
                ("date", None) => now.format("%Y-%m-%d").to_string(),
                ("date", Some(fmt)) => {
                    render_strftime(&now, fmt).unwrap_or_else(|| caps[0].to_string())
                }
                ("time", None) => now.format("%H:%M").to_string(),
                // Unknown variable → leave the literal `{{...}}` in place.
                _ => caps[0].to_string(),
            }
        })
        .into_owned()
}

/// Format `now` with a strftime string, returning `None` (so the caller keeps
/// the literal) if the format contains an invalid specifier — `format()` would
/// otherwise panic when written.
fn render_strftime(now: &chrono::DateTime<Local>, fmt: &str) -> Option<String> {
    use chrono::format::{Item, StrftimeItems};
    let items: Vec<Item> = StrftimeItems::new(fmt).collect();
    if items.iter().any(|i| matches!(i, Item::Error)) {
        return None;
    }
    Some(now.format_with_items(items.iter()).to_string())
}

/// List all templates, sorted by name.
pub fn list(data_dir: &Path) -> CoreResult<Vec<NoteTemplate>> {
    let dir = templates_dir(data_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut templates = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read_to_string(&path) {
            Ok(data) => match serde_json::from_str::<NoteTemplate>(&data) {
                Ok(tpl) => templates.push(tpl),
                Err(e) => log::warn!("skipping invalid template {path:?}: {e}"),
            },
            Err(e) => log::warn!("failed to read {path:?}: {e}"),
        }
    }

    templates.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(templates)
}

/// Create and persist a new template.
pub fn create(
    data_dir: &Path,
    name: String,
    description: Option<String>,
    content: String,
) -> CoreResult<NoteTemplate> {
    let dir = templates_dir(data_dir);
    std::fs::create_dir_all(&dir)?;

    let template = NoteTemplate {
        id: Uuid::new_v4().to_string(),
        name,
        description: description.unwrap_or_default(),
        content,
        created: Utc::now().to_rfc3339(),
    };

    let json =
        serde_json::to_string_pretty(&template).map_err(|e| CoreError::Serde(e.to_string()))?;
    std::fs::write(dir.join(format!("{}.json", template.id)), json)?;
    Ok(template)
}

/// Delete a template by id.
pub fn delete(data_dir: &Path, id: &str) -> CoreResult<()> {
    let path = templates_dir(data_dir).join(format!("{id}.json"));
    if !path.exists() {
        return Err(CoreError::NotFound(format!("Template not found: {id}")));
    }
    std::fs::remove_file(&path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_list_delete_cycle() {
        let dir = std::env::temp_dir().join(format!("novalis-tpl-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        assert!(list(&dir).unwrap().is_empty());
        let tpl = create(&dir, "Daily".to_string(), None, "# {{date}}".to_string()).unwrap();
        assert_eq!(list(&dir).unwrap().len(), 1);
        delete(&dir, &tpl.id).unwrap();
        assert!(list(&dir).unwrap().is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn render_template_substitutes_title_and_dates() {
        let ctx = TemplateContext {
            title: Some("My Note".to_string()),
        };
        let out = render_template("# {{title}}\n\n{{date}} at {{time}}", &ctx);
        assert!(out.starts_with("# My Note\n"));
        // date is YYYY-MM-DD, time is HH:MM
        let date_re = Regex::new(r"\d{4}-\d{2}-\d{2} at \d{2}:\d{2}").unwrap();
        assert!(date_re.is_match(&out), "got: {out}");
        // `{{date:%Y}}` renders 4 digits.
        assert!(Regex::new(r"^\d{4}$")
            .unwrap()
            .is_match(&render_template("{{date:%Y}}", &ctx)));
    }

    #[test]
    fn render_template_leaves_unknown_and_invalid_literal() {
        let ctx = TemplateContext::default();
        // Unknown variable survives verbatim.
        assert_eq!(render_template("a {{nope}} b", &ctx), "a {{nope}} b");
        // Missing title renders empty, not a panic.
        assert_eq!(render_template("[{{title}}]", &ctx), "[]");
        // Invalid strftime spec is left literal (must not panic).
        assert_eq!(render_template("{{date:%Q}}", &ctx), "{{date:%Q}}");
    }

    #[test]
    fn render_template_repeated_date_is_consistent() {
        let ctx = TemplateContext::default();
        let out = render_template("{{date}}|{{date}}", &ctx);
        let parts: Vec<&str> = out.split('|').collect();
        assert_eq!(parts[0], parts[1]);
    }
}
