//! Task extraction from markdown, the SQLite `tasks` index, and in-file edits
//! (toggle completion, update `@status`). Ported from the reference module.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, CoreResult};
use crate::models::{Task, TaskQuery};

/// Extract tasks (markdown checkboxes) from note content.
pub fn extract_tasks(content: &str, note_path: &str) -> Vec<Task> {
    // Compiled once — this runs per note on every (re)index, and compiling
    // 11 regexes per call dominated the scan cost.
    static TASK_RE: OnceLock<Regex> = OnceLock::new();
    static HEADING_RE: OnceLock<Regex> = OnceLock::new();
    static DUE_RE: OnceLock<Regex> = OnceLock::new();
    static START_RE: OnceLock<Regex> = OnceLock::new();
    static REMIND_RE: OnceLock<Regex> = OnceLock::new();
    static PRIORITY_RE: OnceLock<Regex> = OnceLock::new();
    static STATUS_RE: OnceLock<Regex> = OnceLock::new();
    static REPEAT_RE: OnceLock<Regex> = OnceLock::new();
    static PROJECT_RE: OnceLock<Regex> = OnceLock::new();
    static EPIC_RE: OnceLock<Regex> = OnceLock::new();
    static TAG_RE: OnceLock<Regex> = OnceLock::new();
    let task_re = TASK_RE.get_or_init(|| Regex::new(r"^([ \t]*)- \[([ xX])\] (.+)$").unwrap());
    let heading_re = HEADING_RE.get_or_init(|| Regex::new(r"^ {0,3}#{1,6}\s+(.+)$").unwrap());
    let due_re = DUE_RE.get_or_init(|| Regex::new(r"@due\((\d{4}-\d{2}-\d{2})\)").unwrap());
    let start_re = START_RE.get_or_init(|| Regex::new(r"@start\((\d{4}-\d{2}-\d{2})\)").unwrap());
    let remind_re = REMIND_RE
        .get_or_init(|| Regex::new(r"@remind\((\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\)").unwrap());
    let priority_re =
        PRIORITY_RE.get_or_init(|| Regex::new(r"@priority\((urgent|high|medium|low)\)").unwrap());
    let status_re = STATUS_RE.get_or_init(|| Regex::new(r"@status\(([a-z0-9-]+)\)").unwrap());
    let repeat_re =
        REPEAT_RE.get_or_init(|| Regex::new(r"@repeat\((daily|weekly|monthly|yearly)\)").unwrap());
    let project_re = PROJECT_RE.get_or_init(|| Regex::new(r"@project\(([a-z0-9-]+)\)").unwrap());
    let epic_re = EPIC_RE.get_or_init(|| Regex::new(r"@epic\(([a-z0-9-]+)\)").unwrap());
    let tag_re = TAG_RE.get_or_init(|| Regex::new(r"#(\w+)").unwrap());

    // Display title for the note, derived the same way as the search index.
    let (fm, body) = crate::vault::frontmatter::parse_frontmatter(content);
    let filename = note_path.rsplit('/').next().unwrap_or(note_path);
    let note_title = crate::vault::frontmatter::extract_title(&fm, &body, filename);

    let mut tasks = Vec::new();
    // Stack of (indent width, task id): a task's parent is the nearest preceding
    // task with a strictly smaller indent.
    let mut stack: Vec<(usize, String)> = Vec::new();
    // The nearest preceding markdown heading — the section a task lives under.
    let mut current_heading: Option<String> = None;
    // Skip a leading YAML frontmatter block, and the inside of fenced code
    // blocks, so a `#` line in either isn't mistaken for a heading. (Task line
    // numbers stay 1-based over the full content; task detection itself is left
    // fence-agnostic, matching the prior behavior.)
    let mut in_frontmatter = false;
    let mut in_code_fence = false;

    for (line_idx, line) in content.lines().enumerate() {
        if line_idx == 0 && line.trim_end() == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if line.trim_end() == "---" {
                in_frontmatter = false;
            }
            continue;
        }

        let fence = line.trim_start();
        if fence.starts_with("```") || fence.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            continue;
        }

        if !in_code_fence {
            if let Some(hc) = heading_re.captures(line) {
                let cleaned = hc
                    .get(1)
                    .unwrap()
                    .as_str()
                    .trim_end_matches([' ', '#'])
                    .trim();
                current_heading = (!cleaned.is_empty()).then(|| cleaned.to_string());
                continue;
            }
        }

        if let Some(caps) = task_re.captures(line) {
            let indent = caps.get(1).unwrap().as_str().chars().count();
            let checkbox = caps.get(2).unwrap().as_str();
            let text_raw = caps.get(3).unwrap().as_str().to_string();
            let completed = checkbox == "x" || checkbox == "X";

            let due_date = due_re
                .captures(&text_raw)
                .map(|c| c.get(1).unwrap().as_str().to_string());
            let start_date = start_re
                .captures(&text_raw)
                .map(|c| c.get(1).unwrap().as_str().to_string());
            let remind = remind_re
                .captures(&text_raw)
                .map(|c| c.get(1).unwrap().as_str().to_string());
            let priority = priority_re
                .captures(&text_raw)
                .map(|c| c.get(1).unwrap().as_str().to_string());
            let status = status_re
                .captures(&text_raw)
                .map(|c| c.get(1).unwrap().as_str().to_string());
            let project = project_re
                .captures(&text_raw)
                .map(|c| c.get(1).unwrap().as_str().to_string());
            let epic = epic_re
                .captures(&text_raw)
                .map(|c| c.get(1).unwrap().as_str().to_string());
            let tags: Vec<String> = tag_re
                .captures_iter(&text_raw)
                .map(|c| c.get(1).unwrap().as_str().to_string())
                .collect();
            let repeat = repeat_re
                .captures(&text_raw)
                .map(|c| c.get(1).unwrap().as_str().to_string());

            let source_line = line_idx + 1; // 1-based
            let id = make_task_id(note_path, source_line);

            while let Some(&(top_indent, _)) = stack.last() {
                if top_indent >= indent {
                    stack.pop();
                } else {
                    break;
                }
            }
            let parent_id = stack.last().map(|(_, pid)| pid.clone());
            stack.push((indent, id.clone()));

            tasks.push(Task {
                id,
                text: text_raw,
                completed,
                priority,
                due_date,
                start_date,
                remind,
                status,
                source_note: note_path.to_string(),
                source_line,
                tags,
                repeat,
                parent_id,
                note_title: note_title.clone(),
                heading: current_heading.clone(),
                project,
                epic,
            });
        }
    }

    tasks
}

/// Build a markdown task line from its parts. Empty/None annotations are
/// omitted. The result round-trips through [`extract_tasks`].
pub fn build_task_line(
    text: &str,
    status: Option<&str>,
    priority: Option<&str>,
    start: Option<&str>,
    due: Option<&str>,
) -> String {
    let mut parts = vec![format!("- [ ] {}", text.trim())];
    if let Some(s) = status.filter(|s| !s.is_empty()) {
        parts.push(format!("@status({s})"));
    }
    if let Some(p) = priority.filter(|p| !p.is_empty()) {
        parts.push(format!("@priority({p})"));
    }
    if let Some(s) = start.filter(|s| !s.is_empty()) {
        parts.push(format!("@start({s})"));
    }
    if let Some(d) = due.filter(|d| !d.is_empty()) {
        parts.push(format!("@due({d})"));
    }
    parts.join(" ")
}

/// Compute the next due date for a recurring task, or `None` for an
/// unrecognized interval.
pub fn next_due(date: chrono::NaiveDate, repeat: &str) -> Option<chrono::NaiveDate> {
    use chrono::{Days, Months};
    match repeat {
        "daily" => date.checked_add_days(Days::new(1)),
        "weekly" => date.checked_add_days(Days::new(7)),
        "monthly" => date.checked_add_months(Months::new(1)),
        "yearly" => date.checked_add_months(Months::new(12)),
        _ => None,
    }
}

/// Extract a task's `@rrule(...)` iCal recurrence string, if present.
pub fn task_rrule(text: &str) -> Option<String> {
    Regex::new(r"@rrule\(([^)]+)\)")
        .unwrap()
        .captures(text)
        .map(|c| c.get(1).unwrap().as_str().to_string())
}

/// The first occurrence strictly after `date` for an iCal RRULE string (e.g.
/// `FREQ=WEEKLY;BYDAY=MO`), or `None` if the rule is invalid or never recurs.
/// Times are treated as UTC, matching the calendar's recurrence expansion.
pub fn next_rrule(date: chrono::NaiveDate, rrule: &str) -> Option<chrono::NaiveDate> {
    use chrono::{Datelike, TimeZone};
    let dtstart = format!(
        "{:04}{:02}{:02}T000000Z",
        date.year(),
        date.month(),
        date.day()
    );
    let set: rrule::RRuleSet = format!("DTSTART:{dtstart}\nRRULE:{rrule}").parse().ok()?;
    let after = rrule::Tz::UTC
        .with_ymd_and_hms(date.year(), date.month(), date.day(), 23, 59, 59)
        .single()?;
    let next = set.after(after).all(1).dates.into_iter().next()?;
    chrono::NaiveDate::from_ymd_opt(next.year(), next.month(), next.day())
}

/// Deterministic task ID from note path + line number.
fn make_task_id(note_path: &str, line: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{note_path}:{line}"));
    let result = hasher.finalize();
    format!("{result:x}")[..16].to_string()
}

/// Replace all tasks for a note in the database.
pub fn index_tasks(db: &Connection, note_path: &str, tasks: &[Task]) -> CoreResult<()> {
    db.execute(
        "DELETE FROM tasks WHERE source_note = ?1",
        params![note_path],
    )?;

    let mut stmt = db.prepare(
        "INSERT INTO tasks (id, text, completed, priority, due_date, status, source_note, source_line, tags, repeat, parent_id, note_title, heading, project, epic, start_date, remind)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
    )?;

    for task in tasks {
        let tags_json = serde_json::to_string(&task.tags).unwrap_or_else(|_| "[]".to_string());
        stmt.execute(params![
            task.id,
            task.text,
            task.completed as i32,
            task.priority,
            task.due_date,
            task.status,
            task.source_note,
            task.source_line as i64,
            tags_json,
            task.repeat,
            task.parent_id,
            task.note_title,
            task.heading,
            task.project,
            task.epic,
            task.start_date,
            task.remind,
        ])?;
    }

    Ok(())
}

/// Query tasks with optional filters.
pub fn query_tasks(db: &Connection, query: &TaskQuery) -> CoreResult<Vec<Task>> {
    let mut sql = String::from(
        "SELECT id, text, completed, priority, due_date, status, source_note, source_line, tags, repeat, parent_id, note_title, heading, project, epic, start_date, remind FROM tasks WHERE 1=1",
    );
    let mut bind_values: Vec<String> = Vec::new();

    match query.status.as_deref() {
        Some("open") => sql.push_str(" AND completed = 0"),
        Some("completed") => sql.push_str(" AND completed = 1"),
        _ => {}
    }
    if let Some(ref p) = query.priority {
        bind_values.push(p.clone());
        sql.push_str(&format!(" AND priority = ?{}", bind_values.len()));
    }
    if let Some(ref d) = query.due_before {
        bind_values.push(d.clone());
        sql.push_str(&format!(" AND due_date <= ?{}", bind_values.len()));
    }
    if let Some(ref d) = query.due_after {
        bind_values.push(d.clone());
        sql.push_str(&format!(" AND due_date >= ?{}", bind_values.len()));
    }
    if let Some(ref n) = query.note {
        bind_values.push(n.clone());
        sql.push_str(&format!(" AND source_note = ?{}", bind_values.len()));
    }
    if let Some(ref f) = query.folder {
        bind_values.push(format!("{f}%"));
        sql.push_str(&format!(" AND source_note LIKE ?{}", bind_values.len()));
    }

    sql.push_str(" ORDER BY due_date ASC NULLS LAST, source_note, source_line");

    let mut stmt = db.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = bind_values
        .iter()
        .map(|v| v as &dyn rusqlite::types::ToSql)
        .collect();

    let results = stmt
        .query_map(param_refs.as_slice(), |row| {
            let tags_str: String = row.get(8)?;
            let tags: Vec<String> = serde_json::from_str(&tags_str).unwrap_or_default();
            Ok(Task {
                id: row.get(0)?,
                text: row.get(1)?,
                completed: row.get::<_, i32>(2)? != 0,
                priority: row.get(3)?,
                due_date: row.get(4)?,
                status: row.get(5)?,
                source_note: row.get(6)?,
                source_line: row.get::<_, i64>(7)? as usize,
                tags,
                repeat: row.get(9)?,
                parent_id: row.get(10)?,
                note_title: row.get(11)?,
                heading: row.get(12)?,
                project: row.get(13)?,
                epic: row.get(14)?,
                start_date: row.get(15)?,
                remind: row.get(16)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

/// Look up a task's source note and 1-based line by id.
pub fn task_location(db: &Connection, id: &str) -> CoreResult<(String, usize)> {
    let mut stmt = db.prepare("SELECT source_note, source_line FROM tasks WHERE id = ?1")?;
    stmt.query_row(params![id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
    })
    .map_err(|_| CoreError::NotFound(format!("Task not found: {id}")))
}

/// Toggle a task checkbox in the source markdown file. Returns the new state.
pub fn toggle_task(vault: &Path, note_path: &str, line: usize) -> CoreResult<bool> {
    let abs = crate::vault::fs::vault_rel(vault, note_path)?;
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Note not found: {note_path}")));
    }

    let content = std::fs::read_to_string(&abs)?;
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    let idx = line
        .checked_sub(1)
        .ok_or_else(|| CoreError::BadRequest("Invalid line number".to_string()))?;
    if idx >= lines.len() {
        return Err(CoreError::BadRequest(format!(
            "Line {line} out of range (file has {} lines)",
            lines.len()
        )));
    }

    let line_str = &lines[idx];
    let new_state;
    if line_str.contains("- [ ] ") {
        lines[idx] = line_str.replacen("- [ ] ", "- [x] ", 1);
        new_state = true;
    } else if line_str.contains("- [x] ") || line_str.contains("- [X] ") {
        let replaced = line_str.replacen("- [x] ", "- [ ] ", 1);
        lines[idx] = if replaced == *line_str {
            line_str.replacen("- [X] ", "- [ ] ", 1)
        } else {
            replaced
        };
        new_state = false;
    } else {
        return Err(CoreError::BadRequest(format!(
            "Line {line} is not a task checkbox"
        )));
    }

    write_lines(&abs, &content, &lines)?;
    Ok(new_state)
}

/// Update a task's `@status(...)` annotation in the source markdown file.
pub fn update_task_status(
    vault: &Path,
    note_path: &str,
    line: usize,
    new_status: &str,
) -> CoreResult<()> {
    let abs = crate::vault::fs::vault_rel(vault, note_path)?;
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Note not found: {note_path}")));
    }

    let content = std::fs::read_to_string(&abs)?;
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    let idx = line
        .checked_sub(1)
        .ok_or_else(|| CoreError::BadRequest("Invalid line number".to_string()))?;
    if idx >= lines.len() {
        return Err(CoreError::BadRequest(format!(
            "Line {line} out of range (file has {} lines)",
            lines.len()
        )));
    }

    let status_re = Regex::new(r"@status\([a-z0-9-]+\)").unwrap();
    let line_str = &lines[idx];
    if status_re.is_match(line_str) {
        lines[idx] = status_re
            .replace(line_str, format!("@status({new_status})").as_str())
            .to_string();
    } else {
        let trimmed_end = line_str.trim_end();
        let trailing = &line_str[trimmed_end.len()..];
        lines[idx] = format!("{trimmed_end} @status({new_status}){trailing}");
    }

    write_lines(&abs, &content, &lines)?;
    Ok(())
}

/// Set, replace, or remove an `@key(value)` annotation on a task's source line.
/// `value = Some(v)` sets/replaces `@key(v)` (appending if absent, preserving
/// trailing whitespace); `value = None` removes any existing `@key(...)`.
///
/// The task id is derived from path + line and is not stable across edits, so
/// this refuses to touch a line that is no longer a task checkbox.
pub fn update_task_annotation(
    vault: &Path,
    note_path: &str,
    line: usize,
    key: &str,
    value: Option<&str>,
) -> CoreResult<()> {
    let abs = crate::vault::fs::vault_rel(vault, note_path)?;
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Note not found: {note_path}")));
    }

    let content = std::fs::read_to_string(&abs)?;
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    let idx = line
        .checked_sub(1)
        .ok_or_else(|| CoreError::BadRequest("Invalid line number".to_string()))?;
    if idx >= lines.len() {
        return Err(CoreError::BadRequest(format!(
            "Line {line} out of range (file has {} lines)",
            lines.len()
        )));
    }

    let line_str = &lines[idx];
    let task_re = Regex::new(r"^[ \t]*- \[[ xX]\] ").unwrap();
    if !task_re.is_match(line_str) {
        return Err(CoreError::BadRequest(format!(
            "Line {line} is not a task checkbox"
        )));
    }

    let key_esc = regex::escape(key);
    let new_line = match value {
        Some(v) => {
            let set_re = Regex::new(&format!(r"@{key_esc}\([^)]*\)")).unwrap();
            if set_re.is_match(line_str) {
                set_re
                    .replace(line_str, format!("@{key}({v})").as_str())
                    .to_string()
            } else {
                let trimmed_end = line_str.trim_end();
                let trailing = &line_str[trimmed_end.len()..];
                format!("{trimmed_end} @{key}({v}){trailing}")
            }
        }
        None => {
            // Drop the annotation along with one leading space, if present.
            let del_re = Regex::new(&format!(r" ?@{key_esc}\([^)]*\)")).unwrap();
            del_re.replace(line_str, "").to_string()
        }
    };

    lines[idx] = new_line;
    write_lines(&abs, &content, &lines)?;
    Ok(())
}

/// Delete a task's checkbox line from its source note. Guards that the target
/// line is still a task checkbox (the line-derived id is not stable across
/// edits) before removing it.
pub fn delete_task_line(vault: &Path, note_path: &str, line: usize) -> CoreResult<()> {
    let abs = crate::vault::fs::vault_rel(vault, note_path)?;
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Note not found: {note_path}")));
    }

    let content = std::fs::read_to_string(&abs)?;
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    let idx = line
        .checked_sub(1)
        .ok_or_else(|| CoreError::BadRequest("Invalid line number".to_string()))?;
    if idx >= lines.len() {
        return Err(CoreError::BadRequest(format!(
            "Line {line} out of range (file has {} lines)",
            lines.len()
        )));
    }

    let task_re = Regex::new(r"^[ \t]*- \[[ xX]\] ").unwrap();
    if !task_re.is_match(&lines[idx]) {
        return Err(CoreError::BadRequest(format!(
            "Line {line} is not a task checkbox"
        )));
    }

    lines.remove(idx);
    write_lines(&abs, &content, &lines)?;
    Ok(())
}

/// Cut a task's checkbox line plus its contiguous, more-indented child block
/// (subtasks and their wrapped/continuation lines) from the source note,
/// returning the removed lines verbatim. Guards that the target line is still a
/// task checkbox (the line-derived id is not stable across edits) before
/// touching anything. Indent is measured as the parser does — leading
/// whitespace character count — so the block boundary matches `parent_id`.
pub fn cut_task_block(vault: &Path, note_path: &str, line: usize) -> CoreResult<Vec<String>> {
    let abs = crate::vault::fs::vault_rel(vault, note_path)?;
    if !abs.exists() {
        return Err(CoreError::NotFound(format!("Note not found: {note_path}")));
    }

    let content = std::fs::read_to_string(&abs)?;
    let mut lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();

    let idx = line
        .checked_sub(1)
        .ok_or_else(|| CoreError::BadRequest("Invalid line number".to_string()))?;
    if idx >= lines.len() {
        return Err(CoreError::BadRequest(format!(
            "Line {line} out of range (file has {} lines)",
            lines.len()
        )));
    }

    let task_re = Regex::new(r"^([ \t]*)- \[[ xX]\] ").unwrap();
    let parent_indent = match task_re.captures(&lines[idx]) {
        Some(caps) => caps.get(1).unwrap().as_str().chars().count(),
        None => {
            return Err(CoreError::BadRequest(format!(
                "Line {line} is not a task checkbox"
            )))
        }
    };

    // Extend over following lines indented strictly deeper than the parent.
    // Stop at the first blank line or a sibling/shallower line.
    let mut end = idx + 1;
    while end < lines.len() {
        let l = &lines[end];
        if l.trim().is_empty() {
            break;
        }
        let indent = l.chars().take_while(|c| *c == ' ' || *c == '\t').count();
        if indent <= parent_indent {
            break;
        }
        end += 1;
    }

    let removed: Vec<String> = lines.drain(idx..end).collect();
    write_lines(&abs, &content, &lines)?;
    Ok(removed)
}

/// Join lines and write, preserving a trailing newline if the original had one.
fn write_lines(abs: &Path, original: &str, lines: &[String]) -> CoreResult<()> {
    let mut joined = lines.join("\n");
    if original.ends_with('\n') {
        joined.push('\n');
    }
    crate::vault::fs::write_atomic(abs, &joined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_task_line_minimal_only_text() {
        assert_eq!(
            build_task_line("Just text", None, None, None, None),
            "- [ ] Just text"
        );
    }

    #[test]
    fn build_task_line_omits_empty_annotations() {
        assert_eq!(
            build_task_line("Task", Some(""), None, Some(""), Some("")),
            "- [ ] Task"
        );
    }

    #[test]
    fn build_task_line_round_trips_through_extract() {
        let line = build_task_line(
            "Buy milk",
            Some("todo"),
            Some("high"),
            Some("2026-05-28"),
            Some("2026-05-30"),
        );
        let tasks = extract_tasks(&line, "_Inbox.md");
        assert_eq!(tasks.len(), 1);
        let t = &tasks[0];
        assert!(t.text.starts_with("Buy milk"));
        assert_eq!(t.status.as_deref(), Some("todo"));
        assert_eq!(t.priority.as_deref(), Some("high"));
        assert_eq!(t.start_date.as_deref(), Some("2026-05-28"));
        assert_eq!(t.due_date.as_deref(), Some("2026-05-30"));
        assert!(!t.completed);
    }

    #[test]
    fn extract_tasks_parses_remind() {
        let tasks = extract_tasks(
            "- [ ] Call @remind(2026-06-10T09:00) @due(2026-06-10)",
            "n.md",
        );
        assert_eq!(tasks[0].remind.as_deref(), Some("2026-06-10T09:00"));
    }

    #[test]
    fn extract_tasks_parses_repeat() {
        let tasks = extract_tasks("- [ ] Standup @repeat(weekly) @due(2026-05-25)", "n.md");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].repeat.as_deref(), Some("weekly"));
    }

    #[test]
    fn extract_tasks_links_subtasks_to_parent() {
        let md = "- [ ] Parent\n  - [ ] Child A\n  - [x] Child B\n- [ ] Other";
        let tasks = extract_tasks(md, "n.md");
        assert_eq!(tasks.len(), 4);
        let parent_id = tasks[0].id.clone();
        assert_eq!(tasks[0].parent_id, None);
        assert_eq!(tasks[1].parent_id.as_deref(), Some(parent_id.as_str()));
        assert_eq!(tasks[2].parent_id.as_deref(), Some(parent_id.as_str()));
        assert_eq!(tasks[3].parent_id, None);
    }

    #[test]
    fn next_due_advances_by_interval() {
        use chrono::NaiveDate;
        let d = NaiveDate::from_ymd_opt(2026, 5, 24).unwrap();
        assert_eq!(next_due(d, "daily"), NaiveDate::from_ymd_opt(2026, 5, 25));
        assert_eq!(next_due(d, "weekly"), NaiveDate::from_ymd_opt(2026, 5, 31));
        assert_eq!(next_due(d, "monthly"), NaiveDate::from_ymd_opt(2026, 6, 24));
        assert_eq!(next_due(d, "yearly"), NaiveDate::from_ymd_opt(2027, 5, 24));
        assert_eq!(next_due(d, "bogus"), None);
    }

    #[test]
    fn next_rrule_advances_to_next_occurrence() {
        use chrono::NaiveDate;
        // 2026-06-01 is a Monday; weekly-on-Monday → the next Monday.
        let mon = NaiveDate::from_ymd_opt(2026, 6, 1).unwrap();
        assert_eq!(
            next_rrule(mon, "FREQ=WEEKLY;BYDAY=MO"),
            NaiveDate::from_ymd_opt(2026, 6, 8)
        );
        assert_eq!(next_rrule(mon, "not-a-rule"), None);
    }

    #[test]
    fn task_rrule_extracts_the_rule() {
        assert_eq!(
            task_rrule("Standup @rrule(FREQ=WEEKLY;BYDAY=MO) @due(2026-06-01)").as_deref(),
            Some("FREQ=WEEKLY;BYDAY=MO")
        );
        assert_eq!(task_rrule("No rule here @due(2026-06-01)"), None);
    }

    #[test]
    fn extract_tasks_captures_heading_note_title_project_epic() {
        let md = "---\ntitle: My Note\n---\n\n# Top\n\n## Section A\n- [ ] Do thing @project(work) @epic(q3)\n";
        let tasks = extract_tasks(md, "Projects/Plan.md");
        assert_eq!(tasks.len(), 1);
        let t = &tasks[0];
        assert_eq!(t.note_title, "My Note");
        assert_eq!(t.heading.as_deref(), Some("Section A"));
        assert_eq!(t.project.as_deref(), Some("work"));
        assert_eq!(t.epic.as_deref(), Some("q3"));
    }

    #[test]
    fn extract_tasks_ignores_headings_inside_code_fences() {
        let md = "## Real Section\n\n```sh\n# just a comment\n```\n\n- [ ] Do it\n";
        let tasks = extract_tasks(md, "n.md");
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].heading.as_deref(), Some("Real Section"));
    }

    #[test]
    fn extract_tasks_note_title_falls_back_to_filename_and_no_heading() {
        let tasks = extract_tasks("- [ ] Lone task", "Inbox/Quick.md");
        assert_eq!(tasks[0].note_title, "Quick");
        assert_eq!(tasks[0].heading, None);
        assert_eq!(tasks[0].project, None);
    }

    #[test]
    fn update_task_annotation_sets_replaces_and_removes() {
        let dir = std::env::temp_dir().join(format!("novalis-ann-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let rel = "n.md";
        let abs = dir.join(rel);
        std::fs::write(&abs, "- [ ] Task\n").unwrap();

        // Append when absent.
        update_task_annotation(&dir, rel, 1, "project", Some("work")).unwrap();
        assert_eq!(
            std::fs::read_to_string(&abs).unwrap(),
            "- [ ] Task @project(work)\n"
        );

        // Replace existing in place.
        update_task_annotation(&dir, rel, 1, "project", Some("home")).unwrap();
        assert_eq!(
            std::fs::read_to_string(&abs).unwrap(),
            "- [ ] Task @project(home)\n"
        );

        // Remove (drops the leading space too).
        update_task_annotation(&dir, rel, 1, "project", None).unwrap();
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), "- [ ] Task\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn task_edits_reject_escaping_note_paths() {
        let dir = std::env::temp_dir().join(format!("novalis-esc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for bad in ["../n.md", "a/../../n.md"] {
            assert!(toggle_task(&dir, bad, 1).is_err());
            assert!(update_task_status(&dir, bad, 1, "todo").is_err());
            assert!(update_task_annotation(&dir, bad, 1, "due", None).is_err());
            assert!(delete_task_line(&dir, bad, 1).is_err());
            assert!(cut_task_block(&dir, bad, 1).is_err());
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn update_task_annotation_rejects_non_task_line() {
        let dir = std::env::temp_dir().join(format!("novalis-ann-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("n.md"), "Just a paragraph\n").unwrap();
        assert!(update_task_annotation(&dir, "n.md", 1, "project", Some("work")).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cut_task_block_returns_verbatim_and_removes_only_its_line() {
        let dir = std::env::temp_dir().join(format!("novalis-cut-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let abs = dir.join("n.md");
        std::fs::write(&abs, "- [ ] First @priority(high)\n- [ ] Second\n").unwrap();

        let removed = cut_task_block(&dir, "n.md", 1).unwrap();
        assert_eq!(removed, vec!["- [ ] First @priority(high)".to_string()]);
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), "- [ ] Second\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cut_task_block_includes_subtasks_and_stops_at_sibling() {
        let dir = std::env::temp_dir().join(format!("novalis-cut-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let abs = dir.join("n.md");
        std::fs::write(
            &abs,
            "- [ ] Parent\n  - [ ] Child A\n  - [x] Child B\n- [ ] Sibling\n",
        )
        .unwrap();

        let removed = cut_task_block(&dir, "n.md", 1).unwrap();
        assert_eq!(
            removed,
            vec![
                "- [ ] Parent".to_string(),
                "  - [ ] Child A".to_string(),
                "  - [x] Child B".to_string(),
            ]
        );
        assert_eq!(std::fs::read_to_string(&abs).unwrap(), "- [ ] Sibling\n");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cut_task_block_stops_at_blank_line() {
        let dir = std::env::temp_dir().join(format!("novalis-cut-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let abs = dir.join("n.md");
        std::fs::write(&abs, "- [ ] Parent\n\n  orphaned note\n").unwrap();

        let removed = cut_task_block(&dir, "n.md", 1).unwrap();
        assert_eq!(removed, vec!["- [ ] Parent".to_string()]);
        assert_eq!(
            std::fs::read_to_string(&abs).unwrap(),
            "\n  orphaned note\n"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cut_task_block_rejects_non_task_line() {
        let dir = std::env::temp_dir().join(format!("novalis-cut-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("n.md"), "Just a paragraph\n").unwrap();
        assert!(cut_task_block(&dir, "n.md", 1).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
