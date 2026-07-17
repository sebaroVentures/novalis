//! The bundled "Novalis Tour" demo vault.
//!
//! First run seeds an empty vault, so none of the app's flagship features have
//! anything to show. [`generate`] instead writes a small, interconnected vault
//! (~13 notes plus a canvas) that exercises the moat end-to-end: `[[wikilinks]]`
//! and the backlinks they produce, typed frontmatter properties with a
//! saved-query note that reads over them, a meeting note linked to people notes,
//! tasks with `@due`/`@remind`/`@start` tokens (so Today/agenda light up), a
//! `.canvas` referencing real notes, `^block-id` markers with a `((^id))`
//! reference, and a "Start here" note pointing at vault chat / the graph / the
//! command palette.
//!
//! Every file is authored in the exact on-disk formats the app already reads —
//! YAML frontmatter ([`crate::vault::frontmatter`]), inline task tokens
//! ([`crate::tasks::index`]), block markers ([`crate::index::blocks`]), and the
//! JSON Canvas shape ([`crate::vault::canvas`]) — so once indexed via the normal
//! [`crate::index::search::build_index`] path the whole vault is live. Note
//! CONTENT is sample data (English prose), never UI, so it does not go through
//! i18n.
//!
//! Task dates are computed relative to the day the tour is generated, so the
//! agenda has something to show on the user's very first run regardless of when
//! that is.

use std::path::Path;

use chrono::{Duration, Local, Utc};

use crate::error::{CoreError, CoreResult};
use crate::vault::fs as vault_fs;

/// Generate the Novalis Tour vault into `target`.
///
/// `target` must be empty or not yet exist — we never overwrite an existing
/// vault's files. Missing parents are created. Notes are written through the
/// vault path guard and the atomic-write helper, exactly like every other
/// write path.
pub fn generate(target: &Path) -> CoreResult<()> {
    if target.exists() {
        let mut entries = std::fs::read_dir(target)?;
        if entries.next().is_some() {
            return Err(CoreError::BadRequest(format!(
                "Target directory is not empty: {}",
                target.display()
            )));
        }
    } else {
        std::fs::create_dir_all(target)?;
    }

    // A single generated-at timestamp keeps every note's `created`/`modified`
    // consistent within one tour.
    let now = Utc::now().to_rfc3339();
    // Local calendar dates relative to today, so the agenda lights up now.
    let today = Local::now().date_naive();
    let day = |offset: i64| {
        (today + Duration::days(offset))
            .format("%Y-%m-%d")
            .to_string()
    };

    for (rel, content) in notes(&now, &day) {
        write_file(target, &rel, &content)?;
    }
    write_file(target, CANVAS_REL, &canvas())?;

    Ok(())
}

/// Vault-relative path of the tour's canvas file.
const CANVAS_REL: &str = "Tour Board.canvas";

/// Write one tour file, creating parent folders. Routes through the vault path
/// guard ([`vault_fs::vault_rel`]) and the atomic writer so a crash mid-write
/// can never leave a truncated note.
fn write_file(vault: &Path, rel: &str, content: &str) -> CoreResult<()> {
    let abs = vault_fs::vault_rel(vault, rel)?;
    if let Some(parent) = abs.parent() {
        std::fs::create_dir_all(parent)?;
    }
    vault_fs::write_atomic(&abs, content)
}

/// The tour's notes as `(vault-relative path, markdown content)` pairs.
///
/// `now` is an RFC 3339 timestamp for the frontmatter `created`/`modified`
/// fields; `day(offset)` yields a local `YYYY-MM-DD` date `offset` days from
/// today, used for the task tokens.
fn notes(now: &str, day: &impl Fn(i64) -> String) -> Vec<(String, String)> {
    let fm = |title: &str, extra: &str| -> String {
        // Minimal, valid YAML frontmatter in the shape `parse_frontmatter`
        // reads. `extra` holds any custom (typed-property) lines.
        format!(
            "---\ntitle: {title}\ncreated: {now}\nmodified: {now}\n{extra}---\n",
            title = title,
            now = now,
            extra = if extra.is_empty() {
                String::new()
            } else {
                format!("{extra}\n")
            },
        )
    };

    let mut out: Vec<(String, String)> = Vec::new();

    // ── Start here ───────────────────────────────────────────────────────────
    out.push((
        "Start Here.md".to_string(),
        format!(
            "{fm}# Start Here 👋\n\nWelcome to the **Novalis Tour** — a real, editable vault that \
shows off what Novalis can do. Everything here is a plain Markdown file you own; \
poke at it, break it, delete it.\n\n\
## Three things to try right now\n\n\
- Open the **command palette** (try `Ctrl/Cmd-K`) and jump anywhere.\n\
- Open the **graph view** to see how these notes connect.\n\
- **Chat with your vault** — ask it \"what is the moat?\" and watch it answer from \
these notes.\n\n\
## Follow the thread\n\n\
- Projects, with typed properties you can query: [[Projects]]\n\
- The people behind them: [[Ada Lovelace]], [[Grace Hopper]], [[Alan Turing]]\n\
- A meeting that ties them together: [[Kickoff — Tour Planning]]\n\
- What actually sets Novalis apart: [[The Moat]]\n\
- Your tasks and agenda: [[Tasks & Agenda]]\n\
- A spatial board: open `Tour Board.canvas`\n\n\
> The single idea this whole tour is built on: ((^moatcore))\n",
            fm = fm("Start Here", "tags:\n  - tour")
        ),
    ));

    // ── Projects saved-query / explainer ─────────────────────────────────────
    out.push((
        "Projects.md".to_string(),
        format!(
            "{fm}# Projects\n\n\
Each project below is a note whose **frontmatter** carries typed properties — \
`status`, `priority`, and an `owner` that resolves to a person note. The query \
engine reads those directly.\n\n\
## The projects\n\n\
- [[Project Apollo]]\n\
- [[Project Borealis]]\n\
- [[Project Cascade]]\n\n\
## Try a query\n\n\
Paste any of these into search — they filter on the properties, not the text:\n\n\
```query\nstatus:active\n```\n\n\
```query\npriority:high status:active\n```\n\n\
```query\nowner:[[Ada Lovelace]]\n```\n\n\
Active work is what's live right now; done work is archived but still queryable.\n",
            fm = fm("Projects", "tags:\n  - tour")
        ),
    ));

    out.push((
        "Projects/Apollo.md".to_string(),
        format!(
            "{fm}# Project Apollo\n\n\
The flagship launch. Owned by [[Ada Lovelace]], with [[Grace Hopper]] on \
reliability.\n\n\
Apollo is where [[The Moat]] gets proven: local-first, yours-forever, and fast.\n\n\
## Open work\n\n\
- [ ] Ship the onboarding tour @due({due}) @priority(high)\n\
- [ ] Draft the launch note @start({start}) @remind({remind}T09:00)\n",
            fm = fm(
                "Project Apollo",
                "tags:\n  - project\nstatus: active\npriority: high\nowner: \"[[Ada Lovelace]]\""
            ),
            due = day(1),
            start = day(0),
            remind = day(1),
        ),
    ));

    out.push((
        "Projects/Borealis.md".to_string(),
        format!(
            "{fm}# Project Borealis\n\n\
Sync and collaboration, owned by [[Grace Hopper]]. Peer-to-peer, end-to-end \
encrypted, no server in the middle.\n\n\
## Open work\n\n\
- [ ] Test conflict resolution across two devices @due({due}) @priority(medium)\n",
            fm = fm(
                "Project Borealis",
                "tags:\n  - project\nstatus: active\npriority: medium\nowner: \"[[Grace Hopper]]\""
            ),
            due = day(3),
        ),
    ));

    out.push((
        "Projects/Cascade.md".to_string(),
        format!(
            "{fm}# Project Cascade\n\n\
The first release, now shipped. Owned by [[Alan Turing]]. Kept here so you can \
see that `status:done` notes stay fully queryable — nothing is ever hidden.\n",
            fm = fm(
                "Project Cascade",
                "tags:\n  - project\nstatus: done\npriority: low\nowner: \"[[Alan Turing]]\""
            ),
        ),
    ));

    // ── People ───────────────────────────────────────────────────────────────
    out.push((
        "People/Ada Lovelace.md".to_string(),
        format!(
            "{fm}# Ada Lovelace\n\n\
Owns [[Project Apollo]]. Open the backlinks panel on this note: every note that \
mentions Ada shows up here automatically, with no manual bookkeeping.\n",
            fm = fm("Ada Lovelace", "tags:\n  - person")
        ),
    ));
    out.push((
        "People/Grace Hopper.md".to_string(),
        format!(
            "{fm}# Grace Hopper\n\n\
Owns [[Project Borealis]] and keeps [[Project Apollo]] reliable.\n",
            fm = fm("Grace Hopper", "tags:\n  - person")
        ),
    ));
    out.push((
        "People/Alan Turing.md".to_string(),
        format!(
            "{fm}# Alan Turing\n\n\
Shipped [[Project Cascade]].\n",
            fm = fm("Alan Turing", "tags:\n  - person")
        ),
    ));

    // ── Meeting note linked to people ────────────────────────────────────────
    out.push((
        "Meetings/Kickoff — Tour Planning.md".to_string(),
        format!(
            "{fm}# Kickoff — Tour Planning\n\n\
**Attendees:** [[Ada Lovelace]], [[Grace Hopper]], [[Alan Turing]]\n\n\
**Re:** [[Project Apollo]]\n\n\
## Notes\n\n\
We agreed the tour has to *show*, not tell — hence this vault.\n\n\
## Action items\n\n\
- [ ] Ada to finalize the Apollo launch checklist @due({due}) @priority(high)\n\
- [ ] Grace to dry-run sync before the demo @due({due2}) @remind({remind}T14:00)\n\
- [ ] Alan to archive [[Project Cascade]] notes @start({start})\n",
            fm = fm("Kickoff — Tour Planning", "tags:\n  - meeting"),
            due = day(0),
            due2 = day(2),
            remind = day(2),
            start = day(0),
        ),
    ));

    // ── The Moat: block ids referenced from Start Here ───────────────────────
    out.push((
        "The Moat.md".to_string(),
        format!(
            "{fm}# The Moat\n\n\
Novalis keeps everything in plain files on your machine — no lock-in, no server, \
no subscription holding your notes hostage. ^moatcore\n\n\
That single property is what everything else builds on:\n\n\
- Backlinks and the graph come free because links are just text in files.\n\
- The query engine reads frontmatter you can also edit by hand. ^moatquery\n\
- Sync is peer-to-peer and end-to-end encrypted — your data never touches us.\n\n\
[[Start Here]] quotes the core idea directly with a block reference.\n",
            fm = fm("The Moat", "tags:\n  - concept")
        ),
    ));

    // ── Tasks & agenda explainer ─────────────────────────────────────────────
    out.push((
        "Tasks & Agenda.md".to_string(),
        format!(
            "{fm}# Tasks & Agenda\n\n\
Any Markdown checkbox is a task. Add inline tokens and it flows into Today, the \
calendar, and the agenda:\n\n\
- `@due(YYYY-MM-DD)` — when it's due\n\
- `@start(YYYY-MM-DD)` — when to begin\n\
- `@remind(YYYY-MM-DDTHH:MM)` — a nudge\n\
- `@priority(high|medium|low)`\n\n\
## Today\n\n\
- [ ] Read [[Start Here]] @due({today}) @priority(high)\n\
- [ ] Skim [[The Moat]] @start({today})\n\
- [ ] Explore the graph view @remind({today}T16:00)\n\n\
## This week\n\n\
- [ ] Try a saved query from [[Projects]] @due({soon})\n\
- [ ] Open `Tour Board.canvas` @due({later})\n\n\
Open **Today** or the **calendar** and these appear on their dates.\n",
            fm = fm("Tasks & Agenda", "tags:\n  - tour"),
            today = day(0),
            soon = day(2),
            later = day(4),
        ),
    ));

    out
}

/// The tour's `.canvas` file: a spatial board referencing real notes plus a
/// caption card, in the JSON Canvas shape the canvas view reads. Kept as a
/// hand-authored string (the core treats canvases as opaque JSON).
fn canvas() -> String {
    r#"{
  "nodes": [
    {
      "id": "start",
      "type": "file",
      "file": "Start Here.md",
      "x": -280,
      "y": -160,
      "width": 320,
      "height": 200
    },
    {
      "id": "moat",
      "type": "file",
      "file": "The Moat.md",
      "x": 120,
      "y": -160,
      "width": 320,
      "height": 200,
      "color": "6"
    },
    {
      "id": "apollo",
      "type": "file",
      "file": "Projects/Apollo.md",
      "x": -80,
      "y": 120,
      "width": 320,
      "height": 200,
      "color": "4"
    },
    {
      "id": "caption",
      "type": "text",
      "text": "A canvas is just another file in your vault. Drag these cards, draw arrows, mix notes with free-form text — it all stays plain and portable.",
      "x": 480,
      "y": 60,
      "width": 260,
      "height": 160
    }
  ],
  "edges": [
    { "id": "e1", "fromNode": "start", "toNode": "moat", "fromSide": "right", "toSide": "left" },
    { "id": "e2", "fromNode": "start", "toNode": "apollo", "fromSide": "bottom", "toSide": "top" },
    { "id": "e3", "fromNode": "moat", "toNode": "apollo", "fromSide": "bottom", "toSide": "right" }
  ]
}
"#
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::get_agenda;
    use crate::index::links::backlinks;
    use crate::index::query::run_query;
    use crate::index::schema;
    use crate::index::search::build_index;

    /// Generate the tour into a fresh temp dir, then index it via the normal
    /// build path and assert the flagship features are all live.
    #[test]
    fn generated_tour_indexes_into_working_features() {
        let base = tempfile::tempdir().unwrap();
        let vault = base.path().join("Novalis Tour");
        generate(&vault).unwrap();

        let db = schema::open_db(&base.path().join("notes.db")).unwrap();
        build_index(&db, &vault).unwrap();

        // Backlinks: several notes link [[Ada Lovelace]], so her note has
        // linked references without any manual bookkeeping.
        let ada = backlinks(&db, &vault, "Ada Lovelace").unwrap();
        assert!(
            ada.len() >= 2,
            "expected Ada Lovelace to have multiple backlinks, got {}",
            ada.len()
        );

        // Typed properties are queryable: the active projects come back from a
        // pure property filter (no full-text match on "active").
        let active = run_query(&db, "status:active").unwrap();
        assert!(
            active.notes.iter().any(|n| n.title == "Project Apollo"),
            "status:active query should return Project Apollo"
        );
        // A relation property resolves to a person note.
        let owned = run_query(&db, "owner:[[Ada Lovelace]]").unwrap();
        assert!(
            owned.notes.iter().any(|n| n.title == "Project Apollo"),
            "owner relation query should return Project Apollo"
        );

        // A valid .canvas exists and lists the notes it references.
        let canvases = crate::vault::canvas::list(&vault);
        assert_eq!(canvases.len(), 1, "exactly one canvas");
        let raw = crate::vault::canvas::read(&vault, &canvases[0].path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let files: Vec<&str> = parsed["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|n| n["file"].as_str())
            .collect();
        assert!(
            files.contains(&"Start Here.md"),
            "canvas references a real note"
        );

        // A block id is defined (the `^moatcore` marker in The Moat) and is
        // referenced via ((^moatcore)) from Start Here.
        let block = crate::index::blocks::resolve_block(&db, "moatcore").unwrap();
        assert!(
            block.found,
            "((^moatcore)) should resolve to a tagged block"
        );
        let refs = crate::index::blocks::block_backlinks(&db, &vault, "moatcore").unwrap();
        assert!(
            refs.iter().any(|r| r.title == "Start Here"),
            "Start Here should reference the ^moatcore block"
        );

        // Tasks with @due/@start land in the agenda window around today.
        let start = Local::now().date_naive().format("%Y-%m-%d").to_string();
        let end = (Local::now().date_naive() + Duration::days(7))
            .format("%Y-%m-%d")
            .to_string();
        let agenda = get_agenda(&db, &start, &end).unwrap();
        assert!(
            agenda.iter().any(|i| i.kind == "task"),
            "agenda window should contain tour tasks"
        );
    }

    #[test]
    fn refuses_a_non_empty_directory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("existing.md"), "keep me").unwrap();
        let err = generate(dir.path()).unwrap_err();
        assert!(matches!(err, CoreError::BadRequest(_)));
        // The pre-existing file is untouched.
        assert_eq!(
            std::fs::read_to_string(dir.path().join("existing.md")).unwrap(),
            "keep me"
        );
    }
}
