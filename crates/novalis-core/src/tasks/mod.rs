//! Task handling.
//!
//! M1 only needs to *count* checkbox tasks for note summaries and the file
//! tree. The full task model (priority, due date, kanban status, recurrence,
//! subtasks) and the SQLite `tasks` index land in M2 — this module grows then.

/// Count markdown checkbox tasks in note content.
///
/// Returns `(total, completed)`. Recognizes list items beginning with `-`,
/// `*`, or `+` followed by `[ ]` (open) or `[x]`/`[X]` (done). Indentation is
/// allowed (subtasks count too).
pub fn count(content: &str) -> (usize, usize) {
    let mut total = 0;
    let mut completed = 0;

    for line in content.lines() {
        let trimmed = line.trim_start();
        let after_bullet = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "));

        let Some(rest) = after_bullet else { continue };

        // Expect a checkbox: `[ ]` or `[x]`/`[X]` followed by a space/EOL.
        let bytes = rest.as_bytes();
        if bytes.len() >= 3 && bytes[0] == b'[' && bytes[2] == b']' {
            match bytes[1] {
                b' ' => total += 1,
                b'x' | b'X' => {
                    total += 1;
                    completed += 1;
                }
                _ => {}
            }
        }
    }

    (total, completed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_open_and_completed_checkboxes() {
        let md = "\
# Notes
- [ ] first
- [x] second
  - [X] nested done
* [ ] star bullet
+ [ ] plus bullet
- not a task
regular text";
        assert_eq!(count(md), (4 + 1, 2));
    }

    #[test]
    fn ignores_non_task_lines() {
        assert_eq!(count("just prose\nand more"), (0, 0));
    }
}
