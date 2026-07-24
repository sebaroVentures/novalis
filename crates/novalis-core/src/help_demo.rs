//! Feature Guide example notes ("Insert example note").
//!
//! Unlike [`crate::tour`] — which seeds a whole standalone demo vault — each
//! topic here is a single, self-contained file the guide inserts into the
//! user's OPEN vault on demand, under `Help examples/`. The file is an ordinary
//! note the user owns from that moment on: poke at it, edit it, delete it.
//! Inserting an example NEVER flips a feature flag — the guide only offers a
//! topic when it makes sense (contrast the tour, which enables what its vault
//! showcases).
//!
//! Every example teaches by demonstrating: it is authored in the exact on-disk
//! syntax the app indexes — inline task tokens ([`crate::tasks::index`]),
//! `^id` block markers and `((^id))` references ([`crate::index::blocks`]),
//! the query DSL ([`crate::index::query`]), typed frontmatter properties
//! ([`crate::vault::frontmatter`]), and the JSON Canvas shape
//! ([`crate::vault::canvas`]) — so an inserted note is live the moment it is
//! indexed, not a screenshot of syntax.
//!
//! Content is English-only by design, following the [`crate::tour`] precedent:
//! note CONTENT is sample data (English prose) the user owns and edits, never
//! UI chrome, so it does not go through i18n.

use chrono::{Duration, Local, Utc};

/// The vault folder every example file lands in.
const FOLDER: &str = "Help examples";

/// Every topic [`demo_note`] knows, in guide (registry) order.
///
/// This is the single source of truth for a contract that spans languages: the
/// frontend's `help/registry.ts` carries a `demoTopic` per topic, and the
/// guide shows its "Create example note" button off that field alone. Nothing
/// in the type system connects the two, so a renamed or misspelled id would
/// only surface as a runtime `badRequest` on click. The list is therefore
/// exported to TypeScript as a specta constant (`DEMO_TOPICS` in
/// `ipc/bindings.ts`, which CI already gates against drift) and
/// `src/help/__tests__/registry.test.ts` asserts set-equality against the
/// registry. Adding a topic means: an arm in [`demo_note`], an entry here, a
/// `demoTopic` in the registry.
pub const DEMO_TOPICS: [&str; 10] = [
    "wikilinks",
    "taskTokens",
    "blockRefs",
    "transclusion",
    "mermaid",
    "math",
    "callouts",
    "properties",
    "queryEngine",
    "canvas",
];

/// The `(vault-relative path, full file content)` for a Feature Guide topic,
/// or `None` for an unknown topic.
///
/// Markdown topics yield a note under [`FOLDER`] with the same frontmatter
/// shape the tour writes; the `canvas` topic yields a `.canvas` file (opaque
/// JSON to the core, self-contained text cards only). Task dates are computed
/// relative to today, so the task-token example shows up in Today/agenda on
/// the day it is inserted.
pub fn demo_note(topic: &str) -> Option<(String, String)> {
    // One generated-at timestamp for the note's `created`/`modified`.
    let now = Utc::now().to_rfc3339();
    // Local calendar dates relative to today, so dated tasks light up now.
    let today = Local::now().date_naive();
    let day = |offset: i64| {
        (today + Duration::days(offset))
            .format("%Y-%m-%d")
            .to_string()
    };

    // Minimal, valid YAML frontmatter in the shape `parse_frontmatter` reads.
    // `extra` holds any custom (typed-property) lines. Mirrors `tour::notes`.
    let fm = |title: &str, extra: &str| -> String {
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

    let (name, content) = match topic {
        "wikilinks" => (
            "Wikilinks.md",
            format!(
                "{fm}# Wikilinks\n\n\
Wrap any note's title in double brackets to link it: [[Wikilinks]] — that one \
points right back at this note, so its backlinks panel already has an entry.\n\n\
## How they work\n\n\
- Type `[[` in the editor and pick a note from the popover.\n\
- Links resolve by note TITLE (frontmatter aliases count too), so moving a \
note between folders breaks nothing.\n\
- Click a link to a note that doesn't exist yet and it is created on the \
spot — link first, write later.\n\n\
## Where they pay off\n\n\
Open the **backlinks panel** on any note: every note linking to it is listed \
automatically, with no manual bookkeeping. The graph view draws the same \
connections as a map.\n",
                fm = fm("Wikilinks", "tags:\n  - example")
            ),
        ),

        "blockRefs" => (
            "Block References.md",
            format!(
                "{fm}# Block References\n\n\
End a line with a space, a caret, and a short id, and that line becomes an \
addressable block:\n\n\
The single idea this note wants you to keep. ^keep0001\n\n\
Quote it from anywhere — this note, any other note — with a double-paren \
reference: ((^keep0001))\n\n\
## Why an id instead of a heading link?\n\n\
The id is random and means nothing, so it survives every edit: rename the \
headings, rewrite the text around it, move the note — the reference above \
still resolves. A link keyed on heading text would have broken silently.\n\n\
## Make your own\n\n\
1. Put the cursor at the end of a line and append a marker of lowercase \
letters and digits (four or more), like the one above.\n\
2. Type `((` anywhere to search your tagged blocks and insert a reference.\n",
                fm = fm("Block References", "tags:\n  - example")
            ),
        ),

        // The live embed points at the WIKILINKS example (embeds resolve by
        // note TITLE, not path) rather than at this note itself: a self-embed
        // would render this whole body nested MAX_EMBED_DEPTH (3) times before
        // the editor stops registering the extension (see
        // packages/editor/src/NovalisEditor.tsx), which reads as a rendering
        // glitch, not a teaching example. Until "Help examples/Wikilinks.md"
        // exists the embed shows a "not found" chip — the prose says so.
        "transclusion" => (
            "Transclusion.md",
            format!(
                "{fm}# Transclusion\n\n\
An embed shows another note's content INSIDE this one, live. On its own line, \
type `![[`, then a note title, then two closing brackets — a wikilink with an \
exclamation mark in front. Add `#Section name` after the title to embed just \
that section.\n\n\
Below is a real embed of the Wikilinks example note. If you haven't inserted \
that example yet, it shows a \"not found\" chip until you do:\n\n\
![[Wikilinks]]\n\n\
The embedded body is read-only here; edit the source note and every embed \
follows. Embeds nest a few levels deep and then stop, so an accidental cycle \
can never recurse forever.\n",
                fm = fm("Transclusion", "tags:\n  - example")
            ),
        ),

        "math" => (
            "Math.md",
            format!(
                "{fm}# Math\n\n\
Inline math sits in single dollars: the golden ratio is \
$\\varphi = \\frac{{1+\\sqrt{{5}}}}{{2}}$, and Euler's identity \
$e^{{i\\pi}} + 1 = 0$ needs no introduction.\n\n\
Display math gets double dollars on its own line:\n\n\
$$\\int_{{-\\infty}}^{{\\infty}} e^{{-x^2}}\\,dx = \\sqrt{{\\pi}}$$\n\n\
Ordinary dollar amounts stay text — $5 here and $10 there — because math \
needs a non-space character just inside each delimiter.\n",
                fm = fm("Math", "tags:\n  - example")
            ),
        ),

        "mermaid" => (
            "Mermaid Diagrams.md",
            format!(
                "{fm}# Mermaid Diagrams\n\n\
A fenced code block whose language is `mermaid` renders as a diagram:\n\n\
```mermaid\n\
graph LR\n\
    Capture --> Connect\n\
    Connect --> Create\n\
    Create --> Capture\n\
```\n\n\
Sequence diagrams, pie charts, gantt timelines and more all work — and on \
disk the block stays plain text, so the diagram source travels with your \
vault and diffs like code.\n",
                fm = fm("Mermaid Diagrams", "tags:\n  - example")
            ),
        ),

        "callouts" => (
            "Callouts.md",
            format!(
                "{fm}# Callouts\n\n\
A blockquote whose first line starts with a `[!type]` marker renders as a \
callout box:\n\n\
> [!tip] Name your callouts\n\
> The text after the marker becomes this box's title.\n\n\
> [!warning]\n\
> Without a title, the type itself is the label.\n\n\
Known types: note, tip, info, warning, danger, success, question, quote, \
caution, important, error. An unknown type falls back to a plain note box — \
and on disk it all stays an ordinary Markdown blockquote.\n",
                fm = fm("Callouts", "tags:\n  - example")
            ),
        ),

        "taskTokens" => (
            "Task Tokens.md",
            format!(
                "{fm}# Task Tokens\n\n\
Any Markdown checkbox is a task. Inline `@` tokens give it dates and \
metadata, and it flows into Today, the calendar, the agenda, and the boards:\n\n\
- [ ] Skim this example @due({due}) @priority(high)\n\
- [ ] Start something small @start({start}) @remind({remind}T09:00)\n\
- [ ] File me on a board @status(doing) @project(examples) #demo\n\
- [x] Checked boxes stay queryable @repeat(weekly)\n\
\x20\x20\x20\x20- [ ] Indent a checkbox under another to make a subtask\n\n\
## The tokens\n\n\
- `@due(YYYY-MM-DD)` / `@start(YYYY-MM-DD)` — when it's due / when to begin\n\
- `@remind(YYYY-MM-DDTHH:MM)` — a timed nudge\n\
- `@priority(urgent|high|medium|low)` — ordering in the task views\n\
- `@status(...)`, `@project(...)`, `@epic(...)` — kanban columns and lanes\n\
- `@repeat(daily|weekly|monthly|yearly|every 3 days)` — recurrence\n\
- `#tags` on the line travel with the task\n\n\
Open **Today** or the calendar and the dated tasks above appear on their \
days.\n",
                fm = fm("Task Tokens", "tags:\n  - example"),
                due = day(1),
                start = day(0),
                remind = day(1),
            ),
        ),

        "queryEngine" => (
            "Query Engine.md",
            format!(
                "{fm}# Query Engine\n\n\
A query is a line of filters; every note matching ALL of them comes back. \
This very note carries `status: active` and `rating: 5` in its frontmatter, \
so each of these finds it — paste one into search:\n\n\
```query\nstatus:active\n```\n\n\
```query\nrating>=4 -tag:archived\n```\n\n\
```query\nhas:task task.priority:high\n```\n\n\
- [ ] The task that makes the third query match @priority(high)\n\n\
## The pieces\n\n\
- `word` or `\"a phrase\"` — full-text match\n\
- `tag:...`, `folder:...`, `title:...`, `path:...` — the classics\n\
- `type:example` — any frontmatter property as `key:value`\n\
- `rating>=4` — numeric comparisons: `<`, `<=`, `>`, `>=`, `=`, `!=`\n\
- typed relations — `key:` followed by a bracketed note title, matching \
notes whose relation points at that note\n\
- `has:task`, `has:link`, `has:backlink`, `has:deadline` — existence checks\n\
- `task.status:done`, `task.due<2027-01-01` — task facets\n\
- a leading `-` negates any term, e.g. `-tag:archived`\n\
- `sort:modified:desc` and `view:kanban` — ordering and views\n",
                fm = fm(
                    "Query Engine",
                    "tags:\n  - example\nstatus: active\nrating: 5\ntype: example"
                )
            ),
        ),

        "properties" => (
            "Properties.md",
            format!(
                "{fm}# Properties\n\n\
The YAML frontmatter at the top of this file carries typed properties — open \
the properties panel and they appear as editable fields, not text:\n\n\
- `status: draft` — text\n\
- `rating: 4` — a number, so `rating>=4` comparisons work in queries\n\
- `reviewed: false` — a checkbox\n\
- `topics:` — a list\n\
- a value that wraps another note's title in quoted double brackets (the \
same brackets a wikilink uses) becomes a RELATION between the two notes\n\n\
Edit them in the panel or straight in the YAML — they are the same thing, \
and the file stays plain Markdown. The query engine reads them directly: try \
`status:draft` in search while this note is in your vault.\n",
                fm = fm(
                    "Properties",
                    "tags:\n  - example\nstatus: draft\npriority: medium\nrating: 4\nreviewed: false\ntopics:\n  - metadata\n  - examples"
                )
            ),
        ),

        // A `.canvas` (opaque JSON to the core, written without note
        // indexing). Self-contained: text cards only, so nothing can dangle.
        "canvas" => return Some((format!("{FOLDER}/Example Board.canvas"), canvas())),

        _ => return None,
    };

    Some((format!("{FOLDER}/{name}"), content))
}

/// The canvas example: a small board of free-form text cards in the JSON
/// Canvas shape the canvas view reads. Kept as a hand-authored string (the
/// core treats canvases as opaque JSON), mirroring `tour::canvas`.
fn canvas() -> String {
    r#"{
  "nodes": [
    {
      "id": "welcome",
      "type": "text",
      "text": "A canvas is a spatial board — and just another file in your vault. Drag this card around; nothing here is locked in.",
      "x": -340,
      "y": -60,
      "width": 300,
      "height": 160
    },
    {
      "id": "cards",
      "type": "text",
      "text": "Add cards for loose thoughts, then draw arrows between them when the structure emerges.",
      "x": 40,
      "y": -180,
      "width": 300,
      "height": 150,
      "color": "4"
    },
    {
      "id": "notes",
      "type": "text",
      "text": "Cards can also be whole notes from your vault — mix free-form text with real files on one board.",
      "x": 40,
      "y": 40,
      "width": 300,
      "height": 150,
      "color": "6"
    }
  ],
  "edges": [
    { "id": "e1", "fromNode": "welcome", "toNode": "cards", "fromSide": "right", "toSide": "left" },
    { "id": "e2", "fromNode": "welcome", "toNode": "notes", "fromSide": "right", "toSide": "left" }
  ]
}
"#
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::blocks;
    use crate::index::query::run_query;
    use crate::index::{schema, search};
    use crate::models::NoteSummary;

    fn summary(path: &str, title: &str) -> NoteSummary {
        NoteSummary {
            path: path.to_string(),
            title: title.to_string(),
            folder: FOLDER.to_string(),
            tags: vec![],
            aliases: vec![],
            created: String::new(),
            modified: String::new(),
            pinned: false,
            word_count: 0,
            task_total: 0,
            task_completed: 0,
            cloud_only: false,
        }
    }

    #[test]
    fn every_topic_returns_content_under_the_examples_folder() {
        // DEMO_TOPICS is the exported contract (see its docs) — iterating it
        // here is what makes it exhaustive rather than a second hand-kept list.
        for topic in DEMO_TOPICS {
            let (rel, content) = demo_note(topic).unwrap_or_else(|| panic!("topic {topic}"));
            assert!(rel.starts_with("Help examples/"), "{topic} path: {rel}");
            if rel.ends_with(".canvas") {
                serde_json::from_str::<serde_json::Value>(&content).unwrap();
                continue;
            }
            assert!(rel.ends_with(".md"), "{topic} path: {rel}");
            // Valid frontmatter in the shape the indexer parses, plus a body.
            assert!(content.starts_with("---"), "{topic} has frontmatter");
            let (fm, body) = crate::vault::frontmatter::parse_frontmatter(&content);
            assert!(fm.title.is_some(), "{topic} frontmatter has a title");
            assert!(!body.trim().is_empty(), "{topic} has a body");
        }

        // The one non-markdown topic, pinned by name.
        assert_eq!(
            demo_note("canvas").unwrap().0,
            "Help examples/Example Board.canvas"
        );

        // Unknown topic → None (the command turns this into a bad request).
        assert!(demo_note("teleportation").is_none());
    }

    /// Index the block-refs demo via the normal `index_note` path (all-on
    /// options) and assert its self-referencing block is live: the marker
    /// resolves and the `((^id))` reference registers as a block backlink.
    #[test]
    fn block_refs_demo_indexes_a_resolvable_self_referencing_block() {
        let vault = tempfile::tempdir().unwrap();
        let db = schema::open_db(&vault.path().join("notes.db")).unwrap();

        let (rel, content) = demo_note("blockRefs").unwrap();
        // The backlink snippet phase reads the referencing file from disk.
        let abs = vault.path().join(&rel);
        std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
        std::fs::write(&abs, &content).unwrap();
        search::index_note(&db, &summary(&rel, "Block References"), &content).unwrap();

        let ids = blocks::extract_block_ids(&content);
        assert!(!ids.is_empty(), "demo must define a tagged block");
        let id = &ids[0].id;

        let hit = blocks::resolve_block(&db, id).unwrap();
        assert!(hit.found, "((^{id})) should resolve to a tagged block");
        assert_eq!(hit.note_path.as_deref(), Some(rel.as_str()));

        let refs = blocks::block_backlinks(&db, vault.path(), id).unwrap();
        assert!(
            refs.iter().any(|r| r.path == rel),
            "the demo should reference its own block"
        );
    }

    #[test]
    fn task_tokens_demo_yields_parsed_tasks_with_tokens() {
        let (rel, content) = demo_note("taskTokens").unwrap();
        let tasks = crate::tasks::index::extract_tasks(&content, &rel);
        assert!(tasks.len() >= 4, "got {} tasks", tasks.len());
        assert!(tasks.iter().any(|t| t.due_date.is_some()));
        assert!(tasks.iter().any(|t| t.priority.as_deref() == Some("high")));
        assert!(tasks.iter().any(|t| t.completed));
        assert!(
            tasks.iter().any(|t| t.parent_id.is_some()),
            "the subtask demo line should nest"
        );
    }

    /// The query-engine demo's claim ("each of these finds it") is pinned:
    /// indexed via `index_note`, every example query returns the note itself.
    #[test]
    fn query_engine_demo_matches_its_own_example_queries() {
        let dir = tempfile::tempdir().unwrap();
        let db = schema::open_db(&dir.path().join("notes.db")).unwrap();
        let (rel, content) = demo_note("queryEngine").unwrap();
        search::index_note(&db, &summary(&rel, "Query Engine"), &content).unwrap();

        for q in [
            "status:active",
            "rating>=4 -tag:archived",
            "has:task task.priority:high",
        ] {
            let res = run_query(&db, q).unwrap();
            assert!(
                res.notes.iter().any(|n| n.path == rel),
                "query `{q}` should match the demo note"
            );
        }
    }

    /// The canvas demo round-trips through the real canvas API and is fully
    /// self-contained (text cards only — no file nodes that could dangle).
    #[test]
    fn canvas_demo_is_valid_and_self_contained() {
        let vault = tempfile::tempdir().unwrap();
        let (rel, content) = demo_note("canvas").unwrap();

        crate::vault::canvas::create(vault.path(), &rel, &content).unwrap();
        let listed = crate::vault::canvas::list(vault.path());
        assert_eq!(listed.len(), 1, "exactly one canvas");
        assert_eq!(listed[0].path, rel);

        let raw = crate::vault::canvas::read(vault.path(), &rel).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let nodes = parsed["nodes"].as_array().unwrap();
        assert!(!nodes.is_empty());
        for n in nodes {
            assert_eq!(n["type"], "text", "self-contained: text cards only");
            assert!(n["text"].is_string());
            for k in ["x", "y", "width", "height"] {
                assert!(n[k].is_i64(), "node field {k} must be present");
            }
        }
        let edges = parsed["edges"].as_array().unwrap();
        for e in edges {
            assert!(e["fromNode"].is_string() && e["toNode"].is_string());
        }
    }
}
