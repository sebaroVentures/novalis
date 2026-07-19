# Novalis

A local-first, open-source **notes + tasks + calendar** app. Your data stays on
your device as plain Markdown files; it syncs between devices via OneDrive (or
any file-sync tool). Built with **Tauri v2** (Rust core + web UI) for
macOS/Linux/Windows today, and Android/iOS later — from one codebase.

> Status: early development. The foundation (notes/editor/vault/search, tasks,
> calendar, export/media/templates, plugin system, mobile-ready base) is complete,
> plus a large set of specialized capabilities (AI, canvas, PDF, voice, graph,
> query engine, sync). See `crates/`/`apps/` for structure.

## Features

Novalis is a **notes + tasks + calendar** app first. That core is always on.
On top of it sits a set of **specialized, opt-in capabilities** — you only turn
on what you need, so a plain-notes user is never overwhelmed by features they
won't use.

### Core (always on)

- **Editor** — Markdown with a formatting toolbar and `/` slash menu,
  `[[wikilinks]]` with autocomplete, tables, image paste/drop, find & replace,
  callouts, an outline panel, code-block syntax highlighting, and `#tag`
  autocomplete. Reading mode and spellcheck included.
- **Vault & navigation** — plain `.md` files in a folder, a file tree, tag
  browser, backlinks / linked references, and full-text + fuzzy search.
- **Tasks** — Markdown checkboxes with `@due` / `@remind` / `@start` (natural-
  language dates), a Today/agenda view, and a Kanban board.
- **Calendar** — month/week/day views over your own events (stored as Markdown),
  with reminders and notifications.
- **Safety** — autosave, version history, in-vault trash, and external-change
  conflict detection for cloud-synced vaults.

### Specialized & opt-in

These are off by default and enabled per need. Some need a one-time setup
(connect an AI provider, build the semantic index); a couple download a model on
first use. Grouped as they'll appear in onboarding and **Settings › Features**:

- **AI** *(needs an AI connection; runs nothing until you use it)* — summarize /
  compose / rewrite actions in the editor, "chat with your vault" (RAG with
  citations), ambient link & tag suggestions while you write, note → task
  extraction, an AI weekly review, and metadata suggestions. **Semantic search**
  ("related notes") builds an index of note embeddings — on-device (a ~130 MB
  local model, downloaded once) or via an OpenAI-compatible endpoint — after
  which lookups stay local.
- **Spatial & media** — **Canvas** boards (portable `.canvas` files), a **PDF**
  reader with highlighting/annotation that links back into notes, and **voice /
  meeting capture** with on-device Whisper transcription (a ~142 MB model,
  downloaded once) that saves a note and can extract tasks.
- **Knowledge graph** — an interactive **link graph**, **typed properties &
  relations** in frontmatter, and AI **entity extraction** (people/orgs/projects).
- **Query engine** — saved database-style views ("Bases++"): filter your notes
  like a query and see them as a table, kanban, or calendar.
- **Editor extras** — math (KaTeX), Mermaid diagrams, block references
  (`^id` / `((^id))`), and transclusion (`![[embed]]`).
- **Sync** — optional Git version history + remote sync, direct **peer-to-peer**
  end-to-end-encrypted sync between your own devices, and read-only calendar
  import (`.ics` subscriptions or Google/Outlook sign-in).
- **Power-user** — a JavaScript **plugin** system (sandboxed in Web Workers),
  reusable templates, daily notes, and fully configurable keybindings.

> A unified onboarding step and a **Settings › Features** panel to turn these
> groups on and off in one place are on the near-term roadmap; today several are
> already gated individually (an AI connection, the git-sync toggle, building the
> semantic index, etc.).

## Releases

Pre-built installers are published on the
[GitHub Releases](https://github.com/grundhofer/novalis/releases) page
for macOS (universal `.dmg`), Linux (`.AppImage`, `.deb`), and Windows
(`.msi`, `.exe`).

Builds are currently **unsigned** — macOS and Windows will show a
"verify the developer" warning on first launch. See
[RELEASING.md](RELEASING.md#unsigned-build-warnings-what-users-see)
for how to bypass it.

## Principles

- **Local-first.** No server we run. All logic runs on-device; only `.md` files
  sync. The only network use is the *optional, read-only* calendar import.
- **Own your data.** YAML frontmatter, `[[wikilinks]]`, plain Markdown — vaults
  aim to be Obsidian-compatible. No lock-in.
- **Modular.** Notes, Tasks, and Calendar are internal modules built against an
  extension API that becomes a public plugin API.
- **Open source (MIT).**

## Repository layout

```
crates/
  novalis-core/        UI-agnostic Rust logic (vault, index, notes, tasks, calendar, ...)
  novalis-extension/   internal extension API (public plugin API later)
apps/
  desktop/
    frontend/          React + Vite + Tailwind UI (the shared web UI)
    src-tauri/         thin Tauri v2 binary wiring core -> commands/events
  mobile/              (later) Android/iOS, reuses core + frontend
packages/
  editor/              @novalis/editor — standalone TipTap-based editor
  ui/                  @novalis/ui — shared UI primitives
```

## Development

Prerequisites: Rust (stable), Node 20+, pnpm 11.

```bash
pnpm install                 # install JS deps
cargo test -p novalis-core   # run core unit tests
pnpm gen:bindings            # regenerate typed IPC bindings (Rust -> TS)
pnpm dev                     # run the desktop app (Tauri)
```

### Calendar accounts (optional)

ICS-URL subscriptions (including Google/Outlook private iCal links) work out of
the box. For interactive **Connect Google / Connect Outlook** sign-in, register
your own OAuth client (desktop / "loopback" type, with a calendar read scope)
and provide its client id via env var before launching:

```bash
export NOVALIS_GOOGLE_CLIENT_ID=…   # Google Cloud OAuth client (Desktop app)
export NOVALIS_MS_CLIENT_ID=…       # Azure app registration (public client)
```

No client secret is needed — the flow uses loopback redirect + PKCE, and tokens
are stored in the OS keychain.

## License

MIT © Sebastian Grundhoefer
