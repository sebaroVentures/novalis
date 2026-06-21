# Novalis Tier 1 — Implementation Plan

A build-ordered sequence of small, independently shippable PRs covering: note tag/alias metadata (backend + frontend), editor quick-wins (slash menu, #tag autocomplete, [[ create-new, reading mode, smart paste), template variable rendering, workspace layout polish, and version diff.

## Build order rationale

The **spine** of the metadata work is a single backend pair:

1. **`list_tags` command** — the only source of note-tag-with-counts data.
2. **Inline `#tag` parsing in `build_summary`** — unions body tags into `summary.tags`, which is the single producer feeding `note_meta.tags` + `notes_fts.tags` + quick search + `list_tags`.

Everything tag-facing hangs off these two: the **tag browser sidebar**, the **tag filter dropdown**, the **chip editor**, and the **#tag autocomplete** all consume `list_tags`; and inline-tag parsing makes those surfaces actually reflect what's written in note bodies. So PR-1 ships both, unblocking five downstream features at once.

The **alias work** is independent of tags but shares the same files (`index_note` INSERT, `rows_to_summaries` column order, `NoteSummary`) and is the one item requiring a **`SCHEMA_VERSION` bump (6→7)**. It lands isolated (PR-2) so the column-order edits and the version bump are reviewed together and don't entangle the tag spine.

The editor, template, workspace, and diff workstreams are largely orthogonal and can land in parallel once their deps clear — only **#tag autocomplete (PR-7)** depends on `list_tags` (PR-1), and **resizable sidebar (PR-12)** depends on **collapsible sidebar (PR-11)**.

### Dependency graph

```
PR-1  list_tags + inline #tags  (THE SPINE)
   │
   ├──► PR-3  tag browser sidebar section
   ├──► PR-4  tag filter dropdown (SearchModal)
   ├──► PR-5  tag/alias chip editor (EditorPane)
   └──► PR-7  #tag autocomplete (editor)
        ( PR-5 also depends on PR-2 for the alias data field )

PR-2  alias-aware wiki-link resolution  (SCHEMA 6→7)   ──► PR-5 (alias chips)

PR-6  slash menu                  ─┐
PR-7  #tag autocomplete            │  (PR-7 → PR-1)
PR-8  [[ create-new entry          ├─ editor quick-wins (independent)
PR-9  reading mode toggle          │
PR-10 smart paste (verify)        ─┘

PR-13 template render_template (backend)  ──► PR-14 palette "Insert template"

PR-11 collapsible sidebar  ──► PR-12 resizable sidebar
PR-15 stacked right-rail panels   (independent)
PR-16 version diff view           (independent, adds `similar` crate)
```

### Two correctness invariants that gate the whole plan

- **Template `{{date}}` latent bug (PR-13).** `notes/mod.rs:33-47` uses `tpl.content` **verbatim** at line 41 — no substitution — so `{{date}}`/`{{title}}`/`{{time}}` are written literally into new notes today. There is **no seeded "Daily" template** (the only `# {{date}}` literal is the test at `templates/mod.rs:86`); the hint that "the seeded Daily template ships `# {{date}}`" is **wrong**. The fix is substitution on the create path, not a seeder.
- **Flush-before-switch / round-trip safety.** Any editor or note-meta write must:
  - `await flushPending()` (`EditorPane.tsx:154-164`) **before** a concurrent frontmatter write (`updateNoteMeta`) or a note switch, so a pending body autosave and the meta write don't race the same `.md` file — exactly as `commitTitle` (`EditorPane.tsx:313`) and `renameItem` already do.
  - **Never** bump `activeNoteVersion` on a meta-only save — that key forces a full editor remount (`EditorPane.tsx:467`) and drops cursor/scroll. `renameItem` updates `activeNote` without bumping; copy that.
  - **Never** introduce custom ProseMirror nodes or rewrite the body to "normalize" — slash items, `#tags`, `[[links]]`, math, mermaid, and pasted links must all serialize through the existing `tiptap-markdown` config as plain text/standard nodes (decoration-only invariant). `render_template` emits plain markdown; `extract_body_tags` is pure/read-only.

---

## PR-1 — `list_tags` command + inline `#tag` body parsing (THE SPINE)

**Lands:** the `list_tags` Tauri command (`TagCount[]`) and inline-`#tag` union into note tags. No schema bump.

**Backend files**
- `crates/novalis-core/src/models/search.rs` — add `#[derive(Debug, Clone, Serialize, Deserialize, Type)] #[serde(rename_all = "camelCase")] pub struct TagCount { pub tag: String, pub count: u32 }`. Re-exports via `models/mod.rs:18` (`pub use search::*`) → `novalis_core::models::TagCount`.
- `crates/novalis-core/src/index/search.rs` — add `pub fn list_tags(db: &Connection) -> CoreResult<Vec<TagCount>>`: `SELECT tags FROM note_meta`, deserialize each with `serde_json::from_str::<Vec<String>>().unwrap_or_default()` (same pattern as `rows_to_summaries`, `index/mod.rs:34-35`), aggregate into `HashMap<String,u32>`, collect sorted **count DESC then tag ASC**. **Do not** use SQL `LIKE`/`GROUP BY` — tags are a JSON array per row, so `["work"]` vs `["work-trip"]` would conflate.
- `crates/novalis-core/src/vault/frontmatter.rs` — add `pub fn extract_body_tags(body: &str) -> Vec<String>`:
  - match `#tag` where tag = `[A-Za-z0-9_][A-Za-z0-9_/-]*` (leading alnum/underscore; allow internal `/` and `-` for `#area/work`, `#in-progress`).
  - require a non-word char (or start) before `#`: `(?:^|[^\w/#])#([A-Za-z0-9_][\w/-]*)`.
  - **exclude** ATX headings (`^ {0,3}#{1,6}\s+`), fenced code (` ``` `/`~~~` toggle), and inline code spans (strip backtick-delimited runs per line before scanning). Reuse the fence/heading bookkeeping from `tasks/index.rs:42-74`. **Note correction:** the hint to "mirror `tasks/index.rs:25`" is only **partially correct** — that pattern is `#(\w+)` (no `/` or `-`) and excludes nothing; do not copy it literally.
  - dedup order-preserving (HashSet+Vec like `extract_wiki_links`, `links.rs:31-45`); return **verbatim** (no lowercasing — frontmatter parity, sidebar renders `#${tag}` at `Sidebar.tsx:910`).
- `crates/novalis-core/src/vault/fs.rs` `build_summary` (fs.rs:92-146) — after parsing fm/body (fs.rs:126): `let mut tags = fm.tags.clone(); for t in frontmatter::extract_body_tags(&body) { if !tags.iter().any(|x| x.eq_ignore_ascii_case(&t)) { tags.push(t); } }` and set on `NoteSummary` (fs.rs:140). Keep the cloud-only branch (fs.rs:108-123) returning empty tags. **Do not** touch `index_note` — it already consumes `summary.tags`; the union belongs solely in `build_summary` so it's computed once.
- `apps/desktop/src-tauri/src/commands.rs` — after `quick_search` (~line 321): `#[tauri::command] #[specta::specta] pub fn list_tags(state: State<AppEngine>) -> CmdResult<Vec<TagCount>> { state.with(|e| search::list_tags(&e.db)) }`. Add `TagCount` to the `use novalis_core::models::{…}` block (commands.rs:12-17).
- `apps/desktop/src-tauri/src/lib.rs` — register `commands::list_tags` in `collect_commands!` (lib.rs:44-118), right after `commands::quick_search` (lib.rs:68).

**Frontend files**
- `apps/desktop/frontend/src/ipc/bindings.ts` — **regenerated** by `pnpm gen:bindings`; gains `listTags` + `TagCount`. Never hand-edit.
- `apps/desktop/frontend/src/ipc/api.ts` — add `listTags: () => unwrap(commands.listTags()),` near the search wrappers (api.ts:58-60).

**Commands/bindings:** `listTags: () => typedError<TagCount[], CommandError>(__TAURI_INVOKE("list_tags"))`; `export type TagCount = { tag: string; count: number }`. Run `pnpm gen:bindings` (package.json:13).

**Acceptance criteria**
- Two notes (`["work","idea"]`, `["work"]`) → `list_tags` returns `[{work,2},{idea,1}]` count-desc. Empty vault → `[]`. Malformed tags JSON → dropped, no panic.
- `extract_body_tags`: `see #project/alpha and #in-progress` → `[project/alpha, in-progress]`; tag in fence/backticks/`# Heading`/`a#b`/bare `#` all ignored; `#x #x` deduped.
- Integration: frontmatter `tags:[work]` + body `#urgent #work` → `summary.tags == [work, urgent]` (frontmatter first, case-insensitive dedup). After `index_note`, `search(db, q, None, Some("urgent"))` returns it and `list_tags` includes `{urgent,1}`.
- `cargo test -p novalis-core` green; `pnpm gen:bindings` diff is non-empty and contains `listTags` + `TagCount`.

---

## PR-2 — Alias-aware wiki-link resolution + alias surfacing (SCHEMA 6→7)

**Lands:** populate the existing-but-unwritten `note_meta.aliases` column, surface `aliases` on `NoteSummary`, alias fallback in wiki-link resolution, alias matching in quick search. **Bumps `SCHEMA_VERSION` 6→7** (drop-and-rebuild cache forces re-population — the column already exists at `schema.rs:56` but is never written, so without the bump existing indexes keep it empty).

**Backend files**
- `crates/novalis-core/src/index/schema.rs:15` — `pub const SCHEMA_VERSION: i64 = 7;`. **Coordinate the final number** — confirm no other in-flight workstream also bumps the version this milestone (this plan assumes 7; no other PR here bumps it).
- `crates/novalis-core/src/models/note.rs` — add `#[serde(default)] pub aliases: Vec<String>,` to `NoteSummary` after `tags` (note.rs:44). Update **all** struct literals: `build_summary` cloud branch (fs.rs:108-123 → `aliases: Vec::new()`), normal branch (fs.rs:133-145 → `aliases: fm.aliases.clone()`), and every test `summary()` helper (`index/search.rs:195-209`, `index/links.rs:472-484`, any other). `NoteFrontmatter.aliases` is at `note.rs:24-25` (hint's "note.rs:25" is **correct**).
- `crates/novalis-core/src/index/search.rs` `index_note` (search.rs:47-99) — `let aliases_json = serde_json::to_string(&summary.aliases).unwrap_or_else(|_| "[]".to_string());`; add `aliases` to the `note_meta` INSERT column list + VALUES + `ON CONFLICT DO UPDATE SET`, mirroring `tags` (search.rs:52-73). The INSERT currently **omits** `aliases` entirely.
- `crates/novalis-core/src/index/mod.rs` — add `aliases` to the SELECT in `list_summaries` (mod.rs:19-22) **and** to `quick_search`'s SELECT (`search.rs:173-179`), and deserialize it in `rows_to_summaries` (mod.rs:28-53). **Column-order invariant** (`mod.rs:26-27`): both SELECTs and the row mapper share a fixed column order — add `aliases` at the **same ordinal** in all three (right after `tags`) and bump indices accordingly; an off-by-one silently reads `folder` as `aliases`.
- `crates/novalis-core/src/notes/mod.rs` `resolve_or_create_wiki_link` (notes/mod.rs:156-184 — fn starts at **156**, title-match query at **167-173**; hint's "line 166" is **corrected to 167**) — after the exact-title query returns `None`, before creating a new note: `SELECT path, aliases FROM note_meta WHERE aliases LIKE '%' || ?1 || '%' ORDER BY modified DESC`, then in Rust deserialize and authoritative-check `alias.trim().eq_ignore_ascii_case(title)` (trim, skip empty). Return the match if found; only then fall through to create (notes/mod.rs:178-183).
- `crates/novalis-core/src/index/search.rs` `quick_search` (search.rs:166-182) — broaden WHERE with `OR aliases LIKE ?1` (search.rs:176) so `[[partial]]` surfaces alias hits in the switcher.

**Frontend files**
- `apps/desktop/frontend/src/ipc/bindings.ts` — regenerated; `NoteSummary` gains `aliases: string[]`.
- Frontend `NoteSummary` literals/mocks (grep for `NoteSummary`) must add `aliases`; sidebar/search read `.aliases` optionally. `api.ts` unchanged.

**Acceptance criteria**
- `Recipes.md` with frontmatter `aliases:[Cookbook]` → `resolve_or_create_wiki_link(db, vault, "cookbook") == "Recipes.md"` (no new file). `[[Unknown]]` still creates `Unknown.md`. `[[al]]` does **not** wrongly resolve to a note aliased `Allan` (LIKE is pre-filter; `eq_ignore_ascii_case` is authoritative) — creates `al.md`.
- Note with `aliases:["Acme Corp"]` → `quick_search(db, "acme")` returns it.
- `open_db_sets_schema_version_and_is_reopenable` (schema.rs:120-142) still passes (reads `SCHEMA_VERSION` dynamically). `cargo test -p novalis-core` green; bindings diff shows `NoteSummary.aliases`.

---

## PR-3 — Tag browser sidebar section + tag-filtered view  *(depends on PR-1)*

**Lands:** collapsible "Tags" section in the sidebar with counts and `/`-tree grouping, click-to-filter into a tag-filtered note list.

**Frontend files**
- `apps/desktop/frontend/src/components/Sidebar.tsx` — add a `TagsSection` component near `PinnedSection`/`RecentSection` (~Sidebar.tsx:535) using the `SidebarSection` wrapper (lines 559-586) and the `PinnedSection` pattern (`const [open,setOpen]=useState(true)`, `title={t('tagsHeading')}`, `icon={<Hash size={11}/>}`). Mount it inside the `Ctx.Provider` scroll area **after `RecentSection`** (~Sidebar.tsx:253). Import a `Hash`/`Tag` icon from lucide-react (lines 3-21). **Hide the section (`return null`) when there are no tags**, mirroring `PinnedSection` (line 527).
- Fetch via `api.listTags()` (or the tag store). Build a 2-level tree by splitting tags on `/` (group → leaf); guard `split('/')` so a flat `idea` renders as a top-level leaf. Parent rows aggregate child counts. Render group rows with the `FolderRow` chevron toggle (Sidebar.tsx:777-786); leaf rows as buttons with a colored dot + count badge (`text-[10px] tabular-nums text-fg-faint`, Sidebar.tsx:804-808).
- **Replace the local `tagHue` (Sidebar.tsx:41-45) with the shared `import { tagHue } from '../lib/taskDisplay'`** and delete the duplicate (Rule 3 — don't fork a third copy alongside `taskDisplay.tagHue` and `TaskBadges.TagChip`). Repoint `NoteBadges` (Sidebar.tsx:912) at the shared helper. Tag dots use `hsl(tagHue)` — **no hardcoded hex** (no `--nv` per-tag token exists; this is the established convention).
- Click-to-filter: set a `tagFilter` in a store and switch to a filtered list. **`api.search` returns `[]` for an empty query (search.rs:118)** — do **not** implement the list via `api.search('', null, tag)`. Implement by **client-side filtering `api.listNotes()`** on `NoteSummary.tags`, reusing the `SearchModal` result-row markup (SearchModal.tsx:152-174) or `FlatNoteRow` (Sidebar.tsx:589-607). Picking a result calls `useUi.setView('notes')` + `useVault.openNote(path)` (like `SearchModal.pick`, SearchModal.tsx:93-97).
- Refresh the tag list on note changes by subscribing to the existing reindexed event (`useNovalisEvents`) or re-fetch on vault switch — **do not poll**.
- i18n: add `sidebar.tagsHeading` (+ "no notes with this tag" / clear-filter strings) to all 4 locales.

**New files (optional):** `apps/desktop/frontend/src/components/TagFilterView.tsx` if the filtered list is a standalone surface; `apps/desktop/frontend/src/stores/tagStore.ts` if not folded into `vaultStore`.

**Acceptance criteria**
- Notes tagged `work`, `work/urgent`, `idea` → section shows `work` (aggregating), expandable to `urgent`, plus `idea`, each with correct counts. Click `idea` → filtered list shows exactly idea-tagged notes; clicking a result opens it in Notes view. Section collapse/expand persists in session; hidden when vault has zero tags.
- `npm test` (catalogs.test.ts) green — `sidebar.tagsHeading` present with identical keys across en/de/es/fr.

---

## PR-4 — Tag filter dropdown in SearchModal  *(depends on PR-1)*

**Lands:** a tag `<select>` beside the existing folder dropdown; threads the tag into `api.search`'s already-bound 3rd arg.

**Backend (confirmation + optional hardening)**
- The tag filter is **already wired end-to-end** [XS]: core `search()` accepts `tag: Option<&str>` (search.rs:112-117) → `f.tags LIKE '%"<tag>%'` (search.rs:138-143); the Tauri command threads `tag: Option<String>` (commands.rs:308-315); binding `search: (query, folder, tag)` (bindings.ts:70); `api.ts:58-59` passes it. The only gap is the frontend (`SearchModal.tsx:78` omits the tag).
- **Optional hardening (flag, don't silently change):** the current `LIKE '%"<tag>%'` is a prefix match, so `tag="work"` also matches stored `"workout"` and the closing quote isn't anchored; it's also `format!`-interpolated with only `'`→`''` escaping (search.rs:140-142). Recommended: tighten to anchored exact match via a **bound param** `f.tags LIKE '%"' || ? || '"%'`, which means restructuring `query_map([], …)` (search.rs:150-151 binds no params) to pass the tag — touch carefully, keep folder behavior identical. **This is a judgment call** — prefix matching may be intentional; surface the choice rather than blending.

**Frontend files**
- `apps/desktop/frontend/src/components/SearchModal.tsx` — `const [tag,setTag]=useState('')` beside folder state (line 43); `const [tags,setTags]=useState<TagCount[]>([])` loaded in the open-reset effect (lines 61-69) via `void api.listTags().then(setTags).catch(()=>setTags([]))`; reset `setTag('')` alongside `setFolder('')` (line 66). Add a tag `<select>` after the folder `<select>` (lines 131-145), copying its classes verbatim, default `t('searchAllTags')`, options `#{tc.tag} ({tc.count})`. Widen the filter-bar guard (line 131) from `folders.length>0` to `folders.length>0 || tags.length>0`. Change line 78 to `api.search(query, folder || null, tag || null)` and add `tag` to the effect deps (line 89 → `[query, folder, tag, open]`).
- `apps/desktop/frontend/src/locales/{en,de,es,fr}/vault.json` — add `searchAllTags`.

**Acceptance criteria**
- ⌘K, type a query, pick a tag → results restricted to text-match **AND** tag. "All tags" restores unfiltered. Reopening resets folder + tag. Filter bar renders in a folderless vault when tags exist. catalogs.test.ts green.

---

## PR-5 — Tag & alias chip editor in EditorPane  *(depends on PR-1; aliases from PR-2)*

**Lands:** a tags/aliases chip editor in the EditorPane header, wired to `api.updateNoteMeta` with tag autocomplete.

**Frontend files**
- **New** `apps/desktop/frontend/src/components/ui/ChipInput.tsx` — reusable `{ values, onChange, placeholder, suggestions?, renderChip? }`. Chips with `x` remove, add on Enter/comma, Backspace-on-empty removes last, filtered suggestion dropdown. Copy styling from the title input (EditorPane.tsx:348) and sidebar filter input (Sidebar.tsx:230). **Semantic tokens only** (`bg-surface-2`, `text-fg`, `ring-accent`, `hover:bg-hover`).
- `apps/desktop/frontend/src/components/EditorPane.tsx` — add a compact metadata strip below the breadcrumb/title (~EditorPane.tsx:376) or before the editor body (~line 464). Two `ChipInput`s: **Tags** (chips use shared `TagChip`/`hsl(tagHue)` + remove; autocomplete from `api.listTags().map(t=>t.tag)`) and **Aliases** (plain `bg-surface-2 text-fg-muted` chips, **no autocomplete**). Seed values from `activeNote.frontmatter.tags ?? []` and `activeNote.frontmatter.aliases ?? []` (**not** `NoteSummary`, which lacks aliases). Load tag suggestions in an effect keyed on `activePath`.
- `apps/desktop/frontend/src/stores/vaultStore.ts` — add `setNoteMeta(path, {tags?, aliases?})`: call `api.updateNoteMeta({ path, tags: tags ?? null, aliases: aliases ?? null, title: null, pinned: null })`, then `noteCache.set` → set `activeNote` (**no version bump**) → `refreshTree`. Copy the `renameItem` note-branch (vaultStore.ts:705-719).
- `apps/desktop/frontend/src/locales/{en,de,es,fr}/editor.json` — add `tags`, `aliases`, `addTag`, `addAlias`.

**Correctness (both invariants):**
- On chip add/remove: `await flushPending()` (EditorPane.tsx:154-164) **before** `setNoteMeta` — mirrors `commitTitle` (EditorPane.tsx:313) so the body autosave and frontmatter write don't race.
- `setNoteMeta` **must not bump `activeNoteVersion`** (would remount the editor at EditorPane.tsx:467 and drop cursor) — `renameItem` already does this.
- Always route through `updateNoteMeta` (rewrites YAML, preserves the `extra` passthrough) — never write tags into the body or via `updateNote`.
- Normalize tag input: strip leading `#`, trim, dedupe, reject empty (stored without `#`). Removing the last chip sends `[]` (clear), not `null` (leave unchanged).
- **Aliases are not indexed** (no `aliases` field on `NoteSummary` before PR-2; `list_tags` is tags-only), so Aliases has no suggestion source — by design.

**Acceptance criteria**
- Add a tag chip → frontmatter updates on disk; sidebar tag dots + Tags-section count reflect it after `refreshTree`. Remove last tag → frontmatter `tags` cleared. Add an alias chip → frontmatter `aliases` updated, no autocomplete. Editing tags does **not** remount the editor (cursor/scroll preserved; `activeNoteVersion` unchanged). Rapid body-then-tag edit loses nothing (flush holds). catalogs.test.ts green; `npm run build` (tsc) passes.

---

## PR-6 — Slash command menu (`/`) — fuzzy block-insert

**Lands:** a `/` suggestion menu inserting standard blocks. Purely client-side editor extension.

**Frontend files**
- **New** `packages/editor/src/SlashCommand.ts` — copy `WikiLinkSuggestion.ts` wholesale (same `createRenderer()` popover + `onKeyDown` nav + `Suggestion()` shape, `.nv-suggest`/`.nv-suggest-item` CSS at editor.css:229-263). Differences: `char:'/'`, `allowSpaces:false`, a `findSuggestionMatch` that fires only when `/` **begins a token at a block-insert-valid position** (start-of-line/after-whitespace, empty-ish query) — `/(?:^|\s)\/([\w]*)$/` on `textBefore` (like `findWikiMatch`, WikiLinkSuggestion.ts:34-44), and guard `$position.parent.type.name !== 'codeBlock'`. `command({editor,range,props})` does `editor.chain().focus().deleteRange(range)` **then** `props.run(editor)`. Static `BLOCK_ITEMS` with `run` closures mirroring the Toolbar chains (NovalisEditor.tsx:294-313): H1/H2/H3 → `toggleHeading({level})`; List → `toggleBulletList`; Tasks → `toggleTaskList`; Code → `toggleCodeBlock`; Quote → `toggleBlockquote`; **Callout** → `if(!isActive('blockquote')) toggleBlockquote(); insertContent('[!NOTE] ')`; HR → `setHorizontalRule`; **Math** → `insertContent('$$ $$')` (plain text); **Mermaid** → fenced block with `node.attrs.language='mermaid'` (so `MermaidCodeBlock.addNodeView`, MermaidCodeBlock.ts:49, renders). `addOptions(){return {labels:{…}}}` for translatable labels. Filter items by case-insensitive substring on label+keywords (consistent with the codebase's LIKE approach — no fuzzy lib present). **Table is out of scope** (no table extension installed).
- `packages/editor/src/NovalisEditor.tsx` — add `SlashCommand.configure({ labels:{…} })` to the extensions array (~NovalisEditor.tsx:190) sourced from `NovalisEditorLabels` (interface 63-79, `DEFAULT_LABELS` 81-97, merged via `lbl` at 120).
- `apps/desktop/frontend/src/components/EditorPane.tsx` — add slash labels to the `labels={{…}}` object (EditorPane.tsx:480-496), each via `t('…')`.
- `apps/desktop/frontend/src/locales/{en,de,es,fr}/editor.json` — add slash item labels.

**Correctness:** every item produces only nodes the `tiptap-markdown` config (NovalisEditor.tsx:173-178) already serializes — **no custom nodes**; math/mermaid stay plain text/fenced. Trigger discipline is the main risk: a naive `char:'/'` fires inside URLs/dates (`06/04`) — constrain to start-of-block/after-whitespace. `editorProps.handleKeyDown` (NovalisEditor.tsx:204-211) only intercepts Cmd/Ctrl+F so Suggestion's keymap is unaffected; verify `/` right after `[[` coexists (distinct chars).

**Acceptance criteria**
- `/` at start of empty line opens the menu; `head` filters to headings; Enter inserts H1 and removes `/head`. `a/b` mid-word does **not** open it. Each block round-trips byte-stable across note switch + reopen. catalogs.test.ts green; `cargo test --workspace` green (no backend change).

---

## PR-7 — Inline `#tag` autocomplete  *(depends on PR-1)*

**Lands:** a `#` suggestion popover fed by `list_tags`, inserting plain `#tag` text.

> **Reconciliation:** the editor workstream spec proposes `list_tags() -> Vec<String>`, but PR-1 (metadata backend) already ships `list_tags() -> Vec<TagCount>`. **Use the `TagCount[]` command from PR-1** — do not add a second `list_tags`. The editor callback maps `TagCount[] → string[]`.

**Frontend files**
- **New** `packages/editor/src/TagSuggestion.ts` — copy `WikiLinkSuggestion.ts`: `char:'#'`, `allowSpaces:false`, `findTagMatch` = `/(?:^|\s)#([\w-]*)$/` on `textBefore` (fires only at word start), guard `$position.parent.type.name!=='codeBlock'` (like Math.ts:53). `items()` = `(onSearch?onSearch(query):[])` filtered to those containing the query. `command` inserts **plain text** `#tag` via `insertContentAt(range, [{type:'text', text:'#'+item}])` (mirrors WikiLinkSuggestion.ts:154-160) — never a node. Item type is `string`. Reuse `createRenderer`/`onKeyDown` verbatim.
- `packages/editor/src/NovalisEditor.tsx` — add `onSearchTags?: (query: string) => Promise<string[]>` to `NovalisEditorProps` (~line 40); configure `TagSuggestion.configure({ onSearch: onSearchTags })` in extensions (~line 189), mirroring `WikiLinkSuggestion.configure({onSearch})` (line 189).
- `apps/desktop/frontend/src/components/EditorPane.tsx` — add a `searchTags` `useCallback` mirroring `searchLinkTargets` (EditorPane.tsx:198-205): call `api.listTags()`, map `.map(t=>t.tag)`, filter client-side by substring. Pass `onSearchTags={searchTags}` on `<NovalisEditor>` (~line 473).
- `api.ts` already gains `listTags` in PR-1 — no new wrapper.

**Correctness:** inserted tags are plain `#tag` text (decoration-only invariant; no `tiptap-markdown` change). Trigger discipline avoids firing mid-word/in code. **Data-gap caveat to call out honestly:** with PR-1 merged, `list_tags` now covers **both frontmatter and body** tags (body tags flow into `note_meta.tags` via PR-1's `build_summary` union) — so the editor-spec's "frontmatter-only" limitation **no longer applies** once PR-1 is in. If PR-7 ever lands before PR-1, suggestions would be frontmatter-only; sequence PR-7 after PR-1.

**Acceptance criteria**
- A note with tags → typing `#` in the body lists them; selecting inserts `#tag` text. `a#b` mid-word → no dropdown. `cargo clippy --workspace -D warnings` clean. (The `list_tags` unit test lives in PR-1.)

---

## PR-8 — "Create new note" entry in the `[[` autocomplete

**Lands:** a synthetic "Create …" row in the `[[` popover when nothing matches; insertion stays plain `[[query]]` text (the note materializes lazily on click via the existing `resolveOrCreateWikiLink` flow).

**Frontend files**
- `packages/editor/src/WikiLinkSuggestion.ts` — extend `LinkTarget` (lines 19-22) with optional `create?: boolean`. In `items()` (line 153), after awaiting `onSearch`, if `query.trim()` is non-empty **and no exact case-insensitive title match exists**, push `{title:query, path:'', create:true}` as the **last** item. In `createRenderer.draw` (lines 61-76), render create rows with `options.createLabel(query)` and a `nv-suggest-create` class. `command()` is **unchanged** — it inserts `[[props.title]]` (= `[[query]]` for a create item). Add a `createLabel` option in `addOptions` (translatable).
- `packages/editor/src/NovalisEditor.tsx` — thread the create label via `WikiLinkSuggestion.configure` (line 189) from `NovalisEditorLabels`.
- `apps/desktop/frontend/src/components/EditorPane.tsx` — add the label to `labels={{…}}` (lines 480-496).
- `packages/editor/src/editor.css` — style `.nv-suggest-create` with `--nv-accent`/`--nv-muted` tokens (**no hex**).
- `apps/desktop/frontend/src/locales/{en,de,es,fr}/editor.json` — add the create label.

**Correctness:** lazy-create reuses the existing `onWikiLinkClick → api.resolveOrCreateWikiLink` path (EditorPane.tsx:285-297 → `notes/mod.rs:156-184`), which is case-insensitive and reuses an existing note — no double-create. Don't show "Create" when an exact title already matches. Inserted `[[X]]` is plain text (byte-stable round-trip).

**Acceptance criteria**
- `[[` + a brand-new title → a "Create "X"" row appears last; Enter inserts `[[X]]`; clicking it creates `X.md` and opens it. `[[` + existing title → no duplicate create row. Round-trip stable. catalogs.test.ts green.

---

## PR-9 — Reading mode toggle (per-note rendered view + default-mode pref)

**Lands:** a live `editable=false` reading mode (hides toolbar/caret, dims residual `[[ ]]`/callout markers) + a vault-synced default pref.

> **Reality check (do not mis-frame the UI):** this is a WYSIWYG TipTap editor — `tiptap-markdown` parses markdown into real marks/nodes at load, so `**bold**` has **no literal `**`** to hide. The hint "hide `**`/`[[ ]]` syntax markers" is a misconception. Reading mode's real job: (a) `editable=false` (hides toolbar + caret), and (b) a body CSS class dimming the **only** literally-visible syntax — `[[ ]]` brackets (WikiLink keeps them visible, WikiLink.ts:37-43), the `[!TYPE]` callout prefix, and raw `$…$` when the cursor is inside (Math.ts:58-60).

**Backend files**
- `crates/novalis-core/src/models/preferences.rs` — add to `EditorPrefs` (struct at preferences.rs:115-127) `#[serde(default="default_reading_mode")] pub default_reading_mode: bool`, a `fn default_reading_mode()->bool{false}` (next to `default_spellcheck`, 197-199), and add it to the `Default` impl (preferences.rs:287-290). Update field-by-field prefs tests (preferences.rs:360-377). **No DB/schema change** — Preferences is a JSON file; `#[serde(default)]` keeps old files parseable. Run `pnpm gen:bindings` (EditorPrefs TS type gains `defaultReadingMode`).

**Frontend files**
- `packages/editor/src/NovalisEditor.tsx` — **make `editable` live**: add a `useEffect` calling `editor.setEditable(editable)` when the prop changes (mirror the spellcheck effect, NovalisEditor.tsx:246-249). **This is required** — `editable` is currently mount-only (NovalisEditor.tsx:106, consumed only at `useEditor`, 162), so without `setEditable` flipping the prop does nothing. Add a `nv-reading` root class on `.nv-editor` (NovalisEditor.tsx:259) when `!editable`. The Toolbar is already conditional on `editable` (NovalisEditor.tsx:260) so it hides for free.
- `packages/editor/src/WikiLink.ts` — extend `buildDecorations` to emit `nv-wikilink-bracket` decoration spans on the `[[` and `]]` runs (mirrors `Math.ts`'s `.nv-math-src display:none` approach at editor.css:200) so CSS can hide them in reading mode.
- `packages/editor/src/editor.css` — under `.nv-editor.nv-reading`: `.nv-wikilink-bracket{display:none}` + dim the callout `[!TYPE]` prefix. **Theme tokens only, no hex.**
- `apps/desktop/frontend/src/components/EditorPane.tsx` — `readingMode` `useState` seeded from `editorPrefs?.defaultReadingMode` (`useSettings`, already read at EditorPane.tsx:92); pass `editable={!readingMode}` to `<NovalisEditor>` (currently unpassed → defaults true; add at EditorPane.tsx:466-497). Add a header toggle button next to outline/links (EditorPane.tsx:380-399, copy that pattern incl. `aria-pressed`; lucide `PanelLeft`-style or a book icon). Reset `readingMode` to the default on note switch in the `activePath` cleanup effect (EditorPane.tsx:175-190).
- `apps/desktop/frontend/src/components/settings/panels/EditorPanel.tsx` — add a Switch row "Open notes in reading mode" (copy the spellcheck row, EditorPanel.tsx:32-42) calling `settings.setEditor({ defaultReadingMode: v })`.
- i18n: header button title (`editor.json`) + settings label/desc (`settings.json`) across all 4 locales.

**Correctness:** **flush-before-switch** — if entering reading mode with pending edits, `flushPending()` first (EditorPane.tsx:154); the existing blur-flush (NovalisEditor.tsx:231-244) also fires. **Device-local vs vault-synced split:** per-note `readingMode` is ephemeral `useState` (reset per note) — **never persist it per note**; only the *default* is a pref.

**Acceptance criteria**
- Toggle → toolbar hides, caret gone, content non-editable, `[[ ]]` hidden, callout prefix dimmed. Type → toggle to reading → switch notes: edits saved. `defaultReadingMode` on → newly opened notes start in reading mode; per-note toggle doesn't persist. Prefs default test green. `pnpm gen:bindings` → `EditorPrefs.defaultReadingMode`. 4-locale catalogs green.

---

## PR-10 — Smart paste: URL over selection wraps as link (verify only)

**Lands:** a regression-guarding one-liner + a manual verification note. **No new code.**

> **Already implemented** by `@tiptap/extension-link`: `Link.configure({ openOnClick:false, autolink:true })` (NovalisEditor.tsx:181); `linkOnPaste` defaults **true** and registers a `pasteHandler` that wraps a non-empty selection as a link when the clipboard is exactly one URL — **fully offline** (linkifyjs `find`, no network). The editor's `editorProps.handlePaste` (NovalisEditor.tsx:212-218) only intercepts image files and returns false for text, so the Link handler runs.

**Frontend files**
- `packages/editor/src/NovalisEditor.tsx:181` — **optional** future-proofing: make `linkOnPaste:true` explicit in `Link.configure`. One-line clarity change. **Do not** add a custom `handlePaste` — it runs before extension plugins (NovalisEditor.tsx:212) and would shadow/double-wrap the built-in handler.

**Acceptance criteria**
- Select a word, paste `https://example.com` → word becomes a link (offline). Paste a URL with no selection → text/autolink (unchanged). Link survives note switch + reopen as `[text](url)`.

---

## PR-13 — `render_template` + wire into create-note flow  *(fixes the `{{date}}` latent bug)*

**Lands:** pure-Rust `render_template` substitution, wired into `create()` so new-from-template notes resolve variables instead of writing literals. **No DB/schema change** — templates are JSON files under `<data_dir>/templates/<id>.json`.

**Backend files**
- `crates/novalis-core/src/templates/mod.rs` — add `pub struct TemplateContext { pub title: Option<String> }` and `pub fn render_template(content: &str, ctx: &TemplateContext) -> String`. One `regex::Regex` (already a dep) via `std::sync::OnceLock`, matching `\{\{\s*([a-zA-Z]+)(?::([^}]*))?\s*\}\}`, `replace_all` with a closure. **Capture `chrono::Local::now()` once** so all tokens in one render are consistent. Resolution: `title` → `ctx.title.clone().unwrap_or_default()`; `date` → `now.format("%Y-%m-%d")`; `date:FMT` → `now.format(FMT)` (guard against chrono's Display panic on bad specs — validate/catch and fall back to the literal); `time` → `now.format("%H:%M")`; **unknown var or malformed strftime → leave `{{…}}` literal untouched** (no data loss). Use `chrono::Local` (matches `tasks/service.rs:29,166`), not Utc.
- `crates/novalis-core/src/notes/mod.rs:33-47` — in `create()` (sig `pub fn create(db, vault, data_dir, req: CreateNoteRequest) -> CoreResult<Note>`, notes/mod.rs:25-52), replace the verbatim `tpl.content` at **line 41** with `templates::render_template(&tpl.content, &ctx)`; build `ctx.title` from `req.path`'s filename stem. Add `use crate::templates::{self, TemplateContext};`. Leave the `content`/`None` branch unchanged.

**Frontend:** none. `createNote` (api.ts:39-46) and `vaultStore.newNote(folder, templateId)` (vaultStore.ts:483-493) benefit automatically.

**Correctness:** **no seeder** — the fix is substitution on the create path (the hint about a seeded Daily template is wrong). Render emits plain markdown (round-trips through `tiptap-markdown` untouched). Unknown/invalid vars pass through literally (dropping them would be silent data loss).

**Acceptance criteria**
- `cargo test -p novalis-core`: new render tests (`{{title}}`, `{{date}}`, `{{date:%Y/%m/%d}}`, `{{time}}`, unknown-var passthrough, multi-occurrence consistency) + existing template/create cycle tests green. Manual: a template `# {{title}}\n\n{{date:%A, %B %-d}} at {{time}}` resolves on disk and in the editor; `{{nope}}` survives verbatim; `{{date:%Q}}` doesn't crash.

---

## PR-14 — Command-palette "Insert template…" action  *(depends on PR-13)*

**Lands:** a per-template palette command that renders + inserts at the cursor via the markdown-aware `insertContent`.

> **Decision (flag the duplication):** default plan is **TS-side render** for synchronous offline insertion (no bindings regen, no async round-trip). The **alternative** — a `render_template(content, title) -> CmdResult<String>` Tauri command for exact grammar parity — is cleaner if strftime parity matters. **Pick one; this plan defaults to TS-render** and flags that JS lacks strftime, so `{{date:FMT}}` either gets a small token map or passes through unrendered. If exact parity is required, adopt the Rust-render command instead.

**Frontend files**
- `apps/desktop/frontend/src/stores/uiStore.ts` — add `activeEditor: Editor|null` + `setActiveEditor(e)` (`import type { Editor } from '@novalis/editor'`, re-exported at packages/editor/src/index.ts:21). **Do not prop-drill** the TipTap instance through the modal.
- `apps/desktop/frontend/src/components/EditorPane.tsx` — in `handleEditorReady` (line 117) also `useUi.getState().setActiveEditor(ed)`; clear to `null` in the unmount cleanup (175-190) and when no note is active.
- **New** `apps/desktop/frontend/src/lib/templateVars.ts` (TS-render path only) — `renderTemplate(content, { title? })` porting the grammar: `{{title}}`, `{{date}}` (reuse the local YYYY-MM-DD pattern at CommandPalette.tsx:30-33), `{{time}}` HH:MM; `{{date:FMT}}` → small token map or pass-through (document the asymmetry).
- `apps/desktop/frontend/src/components/CommandPalette.tsx` — load templates on open (extend the 83-89 effect, mirror Sidebar.tsx:357-363) into `useState<NoteTemplate[]>`; append one `builtin('insert-template:'+tpl.id, t('cmdInsertTemplate',{name:tpl.name}), null, () => insertTemplate(tpl))`. `insertTemplate`: `const ed = useUi.getState().activeEditor; if(!ed) return; const title = useVault.getState().activeNote?.title; const md = renderTemplate(tpl.content, {title}); ed.chain().focus().insertContent(md).run();` then `onClose()`. **Leave the daily-note path (29-44) untouched.**
- `apps/desktop/frontend/src/locales/{en,de,es,fr}/vault.json` — add `cmdInsertTemplate` (name interpolated, not translated).

**Correctness:** insert via `editor.chain().focus().insertContent(md)` — `tiptap-markdown` overrides `insertContentAt` to parse markdown into real nodes (round-trip safe). **Do not** use `setContent` (replaces whole doc) or inject HTML. Share the editor via `uiStore` and clear on note switch/unmount so a stale editor is never targeted. No-op gracefully when no editor/note is open.

**Acceptance criteria**
- `pnpm -F frontend typecheck && lint`. Cursor mid-paragraph → "Insert template: <name>" lands rendered markdown (resolved `{{title}}`/`{{date}}`/`{{time}}`) and autosaves. i18n completeness gate green for the new key in all 4 locales. No-ops (no crash) with no note open.

---

## PR-11 — Collapsible left sidebar (whole-rail toggle + keybinding)

**Lands:** a device-local collapse bool, a `toggle-sidebar` `ActionId`/keybinding, and a re-open affordance.

**Frontend files**
- `apps/desktop/frontend/src/lib/keybindings.ts` — add `'toggle-sidebar'` to the `ActionId` union (6-17), `ACTION_IDS` (19-31), and `DEFAULT_KEYMAP` (36-48) as `'toggle-sidebar': 'mod+\\'` (**verify `mod+\` is free** against the full map — KeybindingsPanel.tsx:42-44 flags duplicates in red; it's currently unused).
- **New** `apps/desktop/frontend/src/lib/uiPrefs.ts` — `loadSidebarCollapsed()/saveSidebarCollapsed(bool)` mirroring `loadRightPanel/saveRightPanel` (EditorPane.tsx:34-49), key `'novalis:device:sidebarCollapsed'` (global device pref, like `recentLimit` in sidebarPrefs.ts:20).
- `apps/desktop/frontend/src/App.tsx` — `const [sidebarCollapsed,setSidebarCollapsed]=useState(loadSidebarCollapsed)`, persist on change. On the rail wrapper (**App.tsx:184-196** — hint's "185-191" is **corrected**; overlay is 197-202), append `${sidebarCollapsed ? 'md:hidden' : ''}` to collapse on md+ **without breaking the mobile drawer** (`navOpen` + `-translate-x-full` + overlay must keep working below md — `md:hidden` only applies at md+). Add `'toggle-sidebar': () => setSidebarCollapsed(v => { const n=!v; saveSidebarCollapsed(n); return n; })` to the keydown `handlers` record (116-129). Add a re-open button (lucide `PanelLeftOpen`/`PanelLeftClose`) shown only when collapsed on desktop, in the content column (App.tsx:204) calling the same toggle — **ship it in this PR or the rail is unrecoverable on desktop.**
- `apps/desktop/frontend/src/components/settings/SettingsNav.tsx` → `KeybindingsPanel.tsx` `useActionLabels` (17-32) — add `'toggle-sidebar': t('settings:keybindings.toggleSidebar')`.
- Optional: a `CommandPalette` builtin for discoverability.
- i18n: `keybindings.toggleSidebar` in all 4 `settings.json` locales.

**Acceptance criteria**
- `npm test` (catalogs.test.ts) green after adding the label to all locales. `mod+\` collapses/expands on desktop; state survives reload; re-open button works. Below md the hamburger drawer is unaffected. Rebinding in Settings → Keybindings works; cheatsheet shows it.

---

## PR-12 — Resizable sidebar width (draggable divider)  *(depends on PR-11)*

**Lands:** a `cursor-col-resize` divider that resizes the rail with a device-local clamped width.

**Frontend files**
- `apps/desktop/frontend/src/lib/uiPrefs.ts` (same module as PR-11) — `getSidebarWidth(): number` / `setSidebarWidth(n)` clamped `[200, 480]`, default 256 (= `w-64` = 16rem), copying the clamp+try/catch of `getRecentLimit/setRecentLimit` (sidebarPrefs.ts:22-38). Key `'novalis:device:sidebarWidth'`. **Clamp on read too** (defensive against corrupted localStorage).
- `apps/desktop/frontend/src/components/Sidebar.tsx` — change the `<aside>` (line 160) from `w-64` to inline `style={{ width }}` driven by a new `width?: number` prop (add to the signature, Sidebar.tsx:71-83). **Keep `shrink-0`** so flexbox doesn't compress the explicit width.
- `apps/desktop/frontend/src/App.tsx` — own `sidebarWidth` state (`useState(getSidebarWidth)`), pass `width={sidebarWidth}` into Sidebar. Render a thin `cursor-col-resize` divider (4-6px, `hidden md:block`) between the rail wrapper (184-196) and content column (204). Use **Pointer Events + `setPointerCapture`** (drag survives leaving the divider), update width live on `pointermove` (clamp), **persist only on `pointerup`** via `setSidebarWidth`, and `select-none`/disable body text-selection during drag. When collapsed (PR-11), hide both rail and divider.

**Acceptance criteria**
- Drag → width updates live, clamps at min/max, persists across reload. Collapse hides the divider; expand restores the saved width. Below md the drawer is unaffected (no divider). `npm run lint`/typecheck clean.

---

## PR-15 — Stacked right-rail panels (outline AND links simultaneously)

**Lands:** replace the mutually-exclusive `'none'|'links'|'outline'` enum with two independent booleans so both panels can show, stacked vertically in one 72-wide rail.

**Frontend files**
- `apps/desktop/frontend/src/components/EditorPane.tsx` — replace the enum (line 33) with a persisted object `{ links: boolean; outline: boolean }`. Rewrite the `RIGHT_PANEL_KEY='nv:rightPanel'` load/save (34-49) to (de)serialize the object with **back-compat**: map old string `'links'→{links:true,outline:false}`, `'outline'→{outline:true}`, `'none'→both false`, else default `{links:true}` (preserves today's default-open-on-links, EditorPane.tsx:38). Replace `[rightPanel,setRightPanel]` (102) with `[panels,setPanels]`; rewrite `togglePanel(p)` (110-115) to flip `panels[p]` + persist. Repoint the two header buttons (381-399) `aria-pressed`/active to `panels.links`/`panels.outline` (titles unchanged). Replace the exclusive mounts (499-512) with a right-rail wrapper `<div className="flex w-72 shrink-0 flex-col">` containing `{panels.outline && <OutlinePanel stacked .../>}{panels.links && <LinksPanel stacked .../>}`.
- `apps/desktop/frontend/src/components/OutlinePanel.tsx` (line 17) and `LinksPanel.tsx` (line 75) — both hardcode `w-72 shrink-0 border-l` on their `<aside>`. Add a `stacked?: boolean` prop: when stacked, render as `flex-1 min-h-0 overflow-hidden` (width/`border-l` move to the wrapper; add a `border-t` between stacked panels) so two panels split the rail; solo keeps the existing full-rail aside (visually unchanged). Keep each panel's internal logic untouched (LinksPanel `reqId` race handling, OutlinePanel jump).

**No i18n changes** — reuses `links:hide/show/hideOutline/showOutline`.

**Acceptance criteria**
- Toggle links and outline independently; both open at once, stacked. Each close button collapses only its own section. Existing users (old `nv:rightPanel` string) load without losing their last choice; new state persists. Solo mode looks identical to today. `npm run lint`/typecheck clean.

---

## PR-16 — Version diff view (replace raw `<pre>` with line-level diff)

**Lands:** a `versions::diff` core fn (via the `similar` crate) + a `diff_version` Tauri command + binding, and a unified tinted diff in `VersionHistoryModal`. **No schema/migration** — version history is file-based under `<data_dir>/versions/`.

**Backend files**
- `crates/novalis-core/Cargo.toml` — add `similar = "2"` (pure-Rust, pinned literal like regex/walkdir).
- `crates/novalis-core/src/versions/mod.rs` — add `DiffLine { kind: String /* equal|insert|delete */, content: String }` (derive `Type`, `#[serde(rename_all="camelCase")]`, mirroring `VersionMeta` at versions/mod.rs:27-36) after VersionMeta (~36). Add `pub fn diff(data_dir, vault, relative, version_id) -> CoreResult<Vec<DiffLine>>`: `old = read_version(...)`, `new = read_to_string(vault.join(relative))` (empty if missing), `similar::TextDiff::from_lines(&old,&new)`, iter `iter_all_changes()` mapping `ChangeTag::Equal/Insert/Delete` → kind, `content = change.value()` (trim trailing newline). **Cap input** (~1 MiB, like `conflict::read_capped`, conflict/mod.rs:188-193) so the modal can't hang. **Diff direction:** selected snapshot (old) vs current on-disk note (new) = "what changed since this version."
- `apps/desktop/src-tauri/src/commands.rs` — add `#[tauri::command] #[specta::specta] pub fn diff_version(state, path, version_id) -> CmdResult<Vec<DiffLine>>` after `read_version` (~499), delegating to `novalis_core::versions::diff(&e.data_dir, &e.vault_path, &path, &version_id)`. Import `DiffLine` where `VersionMeta` is imported.
- `apps/desktop/src-tauri/src/lib.rs` — register `commands::diff_version` in `collect_commands!` after `commands::read_version` (line 85).

**Frontend files**
- `bindings.ts` — **regenerated** (export_bindings runs on dev start, lib.rs:143-144); gains `diffVersion` + `DiffLine`. Never hand-edit.
- `apps/desktop/frontend/src/ipc/api.ts` — add `diffVersion: (path, versionId) => unwrap(commands.diffVersion(path, versionId))` beside `readVersion` (152-153); re-export `DiffLine`.
- `apps/desktop/frontend/src/components/VersionHistoryModal.tsx` — replace the `readVersion`-driven `preview` string + `<pre>` (40-53, 113-115) with `diff: DiffLine[]` loaded via `api.diffVersion(path, selected.id)` (same cancelled-flag effect). Render rows: `insert` → green tint, `delete` → red tint (reuse `--danger`), `equal` → `text-fg-muted`; keep `font-mono text-[11px] leading-relaxed` + scroll container; add a `+/-` gutter glyph. Handle the **empty-diff case** with a `versions:identical` message (new i18n key) rather than a blank pane (v[0] vs live note may be identical). Restore button + ConfirmDialog (116-137) unchanged.
- **Theme tokens (rules forbid hex):** recommended — add `--diff-add`/`--diff-del` (+ soft bg) to **both** `:root[data-theme]` blocks in `styles.css` (16-81) and expose via `@theme inline`; deletions reuse `--danger`. The codebase has no semantic add/green token (it uses ad-hoc `emerald-500/15`/`red-500/10`). The alternative (ad-hoc Tailwind tints) must be flagged as following the existing status-tint convention; either way deletions stay on `--danger`.
- i18n: `versions:identical` in all 4 locales.

**Acceptance criteria**
- `cargo test -p novalis-core`: `versions::diff` unit test (snapshot vs current → expected insert/delete/equal; identical → all-equal/empty). Dev run regenerates `bindings.ts` with `diffVersion` + `DiffLine`, no TS errors. Manual: select an older snapshot → tinted unified diff (green inserts / red deletes); newest may show "identical". Restore still works and reloads the list. Light + dark both render diff colors. `npm test` (catalogs.test.ts) green with `versions:identical` in all locales.

---

## Effort + sequencing table

| PR | Features | Effort | Depends on |
|----|----------|--------|-----------|
| **PR-1** | `list_tags` command [S] + inline `#tag` body parsing [M] | **M** | — |
| **PR-2** | Alias-aware wiki-link resolution + alias on `NoteSummary` (**SCHEMA 6→7**) [M] | **M** | — |
| **PR-3** | Tag browser sidebar + tag-filtered view [L] | **L** | PR-1 |
| **PR-4** | Tag filter dropdown in SearchModal [S] (+ optional anchored-LIKE hardening) | **S** | PR-1 |
| **PR-5** | Tag & alias chip editor in EditorPane [M] | **M** | PR-1, PR-2 |
| **PR-6** | Slash command menu (`/`) [M] | **M** | — |
| **PR-7** | Inline `#tag` autocomplete [M] | **M** | PR-1 |
| **PR-8** | "Create new note" entry in `[[` autocomplete [S] | **S** | — |
| **PR-9** | Reading mode toggle + default pref [M] | **M** | — |
| **PR-10** | Smart paste (verify + optional explicit `linkOnPaste`) [XS] | **XS** | — |
| **PR-13** | `render_template` + wire into create-note (**`{{date}}` bug fix**) [S] | **S** | — |
| **PR-14** | Command-palette "Insert template…" [M] | **M** | PR-13 |
| **PR-11** | Collapsible left sidebar + keybinding [S] | **S** | — |
| **PR-12** | Resizable sidebar width (draggable divider) [M] | **M** | PR-11 |
| **PR-15** | Stacked right-rail panels [M] | **M** | — |
| **PR-16** | Version diff view (`similar` crate + `diff_version`) [L] | **L** | — |

**Suggested merge waves** (each wave's PRs are independent of each other):
- **Wave A (spine + isolated bug fixes):** PR-1, PR-2, PR-13, PR-10, PR-8, PR-11, PR-15, PR-16
- **Wave B (build on A):** PR-3, PR-4, PR-7 (← PR-1); PR-5 (← PR-1+PR-2); PR-14 (← PR-13); PR-12 (← PR-11); PR-6, PR-9 (independent, can also land in A)

**Cross-workstream coordination flags:**
- Only **PR-2** bumps `SCHEMA_VERSION` (→7); confirm no other milestone work bumps it concurrently.
- **PR-7** must consume PR-1's `list_tags() -> Vec<TagCount>` (the editor spec's `Vec<String>` variant is superseded — do not add a second command).
- **PR-4** must surface (not silently make) the anchored-LIKE vs prefix-match decision; **PR-14** must surface the TS-render vs Rust-render decision.

**Corrected anchors from the specs (preserved above):** `resolve_or_create_wiki_link` is at `notes/mod.rs:156` with the title query at `167-173` (not 166); the App.tsx sidebar wrapper is `184-196` (not 185-191); there is **no seeded Daily template** (the `# {{date}}` is only the test at `templates/mod.rs:86`); "mirror `tasks/index.rs:25`" for body tags is only partially correct (`#(\w+)`, no `/`/`-`, no exclusions); the "hide `**` markers" framing for reading mode is a WYSIWYG misconception; smart paste is already implemented by Link's `linkOnPaste`.