# Novalis

A local-first, open-source **notes + tasks + calendar** app. Your data stays on
your device as plain Markdown files; it syncs between devices via OneDrive (or
any file-sync tool). Built with **Tauri v2** (Rust core + web UI) for
macOS/Linux/Windows today, and Android/iOS later — from one codebase.

> Status: early development. Milestones **M0–M6** complete (scaffolding,
> notes/editor/vault/search, tasks, export/media/templates, calendar +
> OAuth, plugin system, mobile-ready foundation). See `crates/`/`apps/`
> for structure.

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
