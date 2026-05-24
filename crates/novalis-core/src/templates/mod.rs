//! Note templates, stored as JSON files in `<data_dir>/templates/`.

use std::path::Path;

use chrono::Utc;
use uuid::Uuid;

use crate::error::{CoreError, CoreResult};
use crate::models::NoteTemplate;

fn templates_dir(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("templates")
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
}
