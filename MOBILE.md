# Novalis on Mobile — Android first

Novalis is built with Tauri v2, which targets Android and iOS from the **same**
`apps/desktop/src-tauri` crate and the same React frontend — there is no separate
mobile app. The mobile entry point is already wired (`run()` is annotated with
`#[cfg_attr(mobile, tauri::mobile_entry_point)]`).

> **Status (2026-07-08, plan v2).** Android-first is decided (developer account
> exists). This revision replaces the original document-picker plan with a
> **git-sync-first vault strategy** — the git engine (P1–P3b: auto-commit,
> fetch → ff/push/auto-merge, in-app conflict resolution, sync-on-quit) shipped
> since v1 was written and changes what mobile should be.

## Strategy: the vault lives app-private, git is the only sync

v1 planned "platform document picker + URI permissions". That is a trap on
Android: SAF hands out `content://` URIs, not filesystem paths, and
`novalis-core` reads everything through `std::fs` — bridging that means a VFS
layer through the whole core. Instead:

- **The vault lives in the app-private data directory** (a real path;
  `std::fs` works unchanged, no permissions UI, survives app updates).
- **Onboarding = the existing P2a adoption path**: empty folder + remote URL +
  PAT → first sync clones the vault. A slim mobile VaultGate screen replaces
  the folder picker.
- **No OneDrive-folder mode on mobile.** Desktop keeps both modes; a phone
  without the git remote configured is a single-device notebook until one is
  added.

## What's already done for mobile

- One codebase, both targets; mobile entry point wired.
- Desktop-only bits are gated: the `notify` watcher and the auto-commit/sync
  thread are `#[cfg(desktop)]`. Mobile refreshes via `rescan_vault`.
- Responsive UI: activity rail + sidebar slide as one drawer below `md`.
- Icons: `src-tauri/icons/` includes Android `mipmap-*` and iOS `AppIcon-*`.
- `apps/desktop/package.json` has `android:init` / `android:dev` scripts.

## Phase 0 — build spike (GATE; days, no UI work)

The one unverified assumption (flagged in GIT_SYNC_SPIKE.md) is that
git2/vendored-openssl/vendored-libgit2 cross-compile with the Android NDK.
Everything else is routine. Do this first; if it fails hard, re-plan before
touching UI.

Prerequisites: Android Studio (SDK + **NDK**), JDK 17, `ANDROID_HOME`,
`NDK_HOME`, and
`rustup target add aarch64-linux-android x86_64-linux-android`.
Before any android build, `source scripts/android-env.sh` — NDK r23+ has no
GNU-named `*-ranlib` wrappers, and vendored OpenSSL's Makefile needs `RANLIB`
(cargo-mobile2 only exports CC/AR). Verified failure mode otherwise:
`aarch64-linux-android-ranlib: command not found` during `openssl-sys`.

1. `cargo build -p novalis-core --target aarch64-linux-android` — this alone
   answers the git2/openssl question (core depends on git2).
2. `pnpm --dir apps/desktop android:init` then `android:dev` on an emulator —
   boots the real frontend against the real core.
3. Smoke in the emulator: create an app-private vault, write a note, run a
   sync cycle against a real HTTPS remote (PAT), kill + relaunch.

**Gate:** all three pass → Phase 1. openssl build failure → try
`openssl-sys`'s prebuilt/`vendored` NDK docs; last resort is rustls-based
transport work (big — decide consciously).

## Phase 1 — Android alpha (L)

- **Mobile VaultGate**: "create local vault" (app-private) + "connect remote"
  (URL + PAT → adoption clone). Reuse SyncPanel's remote/token IPC.
- **Secrets (alpha tradeoff):** the `keyring` crate has **no Android backend**
  (repo config covers apple-native/secret-service/windows-native only). Alpha
  stores the PAT/AI keys in a file inside the app sandbox and says so in the
  UI; a small Android-Keystore plugin upgrades this in Phase 2. Gate the
  keychain-dependent code paths with `#[cfg]` accordingly.
- **Lifecycle sync instead of watcher/quit-hook:** on resume →
  `rescan_vault` + one sync; on pause → commit + best-effort sync with the
  existing 5s-bounded pattern (desktop hooks `RunEvent::Exit`; mobile uses the
  resume/pause lifecycle events).
- **Touch pass:** editor toolbar hit targets, workspace degrades to a single
  pane (tabs stay, splits hidden), kanban drag on touch, MergeConflictModal on
  a narrow screen (three columns → stacked tabs), safe-area insets.
- **AI:** hide CLI providers (subprocess = desktop-only); HTTP providers and
  embeddings work as-is.
- **Reminders:** existing notification plugin supports Android; polling runs
  only while the app is foregrounded — documented alpha limitation.

## Phase 2 — completion

Android-Keystore secrets plugin; OAuth via deep-link (custom scheme,
`tauri-plugin-deep-link`) for calendar accounts; conflict-modal polish;
internal-track distribution (developer account exists); crash/log story
(tauri-plugin-log already writes to the app log dir).

## Phase 3 — iOS + store pipeline

Same codebase; keychain works via `keyring`'s apple-native backend; expose the
vault in the Files app (`UIFileSharingEnabled`). Wire both stores into
`release.yml` (overlaps with the signing/updater bet).

## Risks

1. **NDK cross-compile of vendored openssl/libgit2** — the Phase-0 gate exists
   precisely for this.
2. **Android System WebView variance** (old devices) — set `minSdk`
   accordingly; test on one real low-end device before any release.
3. **Background execution limits** — sync only runs in foreground/pause
   windows; acceptable for alpha, revisit with WorkManager via a plugin later.
4. **Editor UX in a mobile WebView** (virtual keyboard, selection handles,
   IME) — TipTap is used in mobile browsers widely, but budget a real
   bug-fixing pass, not zero.
