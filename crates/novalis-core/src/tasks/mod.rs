//! Tasks live inline in notes as markdown checkboxes:
//! `- [ ] text @due(YYYY-MM-DD) @priority(urgent|high|medium|low)
//! @status(id) @repeat(daily|weekly|monthly|yearly|every N days|weeks|months)
//! #tag`.
//!
//! [`index`] extracts/queries them and edits the source files; [`service`]
//! adds the create/toggle/status/quick-capture orchestration; [`nldate`]
//! resolves natural-language date phrases entered in date fields.

pub mod index;
pub mod nldate;
pub mod service;

/// `(total, completed)` checkbox counts for note content (used by summaries).
pub fn count(content: &str) -> (usize, usize) {
    let tasks = index::extract_tasks(content, "");
    let completed = tasks.iter().filter(|t| t.completed).count();
    (tasks.len(), completed)
}

#[cfg(test)]
mod tests {
    use super::count;

    #[test]
    fn counts_dash_checkboxes_only() {
        let md = "- [ ] a\n- [x] b\n  - [X] c\n- not a task\nplain text";
        assert_eq!(count(md), (3, 2));
    }
}
