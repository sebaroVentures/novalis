# Releasing Novalis

Novalis releases are built and published by GitHub Actions
(`.github/workflows/release.yml`) when an annotated `v*.*.*` tag is pushed.
The workflow attaches platform installers to a **draft** GitHub release; a
maintainer reviews and publishes it manually.

## Cutting a release

1. **Bump the version** in three places — they must stay in sync:

   - `Cargo.toml` → `[workspace.package] version`
   - `package.json` → `version`
   - `apps/desktop/src-tauri/tauri.conf.json` → `version`

   Commit the bump on `main`:

   ```bash
   git commit -am "chore: release v0.2.0"
   ```

2. **Tag and push:**

   ```bash
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin main v0.2.0
   ```

3. The `Release` workflow runs on three runners (macOS, Ubuntu, Windows),
   builds installers, and creates a draft release named `Novalis v0.2.0`
   with the artifacts attached.

4. Open the draft on GitHub, edit the release notes, then **Publish**.

## What gets built

| Platform | Artifacts                          | Architecture          |
| -------- | ---------------------------------- | --------------------- |
| macOS    | `Novalis_<ver>_universal.dmg`      | Intel + Apple Silicon |
| Linux    | `novalis_<ver>_amd64.deb`,         | x86_64                |
|          | `novalis_<ver>_amd64.AppImage`     |                       |
| Windows  | `Novalis_<ver>_x64_en-US.msi`,     | x86_64                |
|          | `Novalis_<ver>_x64-setup.exe`      |                       |

ARM Linux and ARM Windows are not built yet; add a matrix entry when needed.

## Unsigned-build warnings (what users see)

Until code signing is wired up (Phase B, below), users will see OS warnings on
first launch. They are not malware warnings — they only mean the binary was
not signed with a paid OS-vendor certificate.

- **macOS:** "Novalis can't be opened because Apple cannot check it for
  malicious software." Right-click the app → **Open** → **Open** in the
  dialog. Or: System Settings → Privacy & Security → "Open Anyway".

- **Windows:** SmartScreen blue screen ("Microsoft Defender SmartScreen
  prevented an unrecognized app from starting"). Click **More info** →
  **Run anyway**.

- **Linux:** No warnings. The `.AppImage` needs `chmod +x` before running.

Link to this section from the release notes so users know what to expect.

## Phase B: adding code signing later

When you have certs, add the secrets below to **Settings → Secrets and
variables → Actions** in the GitHub repo. `tauri-action` picks them up
automatically — no workflow code changes needed beyond uncommenting the env
block.

### macOS (Apple Developer ID, ~$99/yr)

| Secret                       | Source                                      |
| ---------------------------- | ------------------------------------------- |
| `APPLE_CERTIFICATE`          | base64-encoded `.p12` of the Developer ID Application cert |
| `APPLE_CERTIFICATE_PASSWORD` | password used when exporting the `.p12`     |
| `APPLE_SIGNING_IDENTITY`     | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID`                   | your Apple ID email                         |
| `APPLE_PASSWORD`             | an **app-specific password** (not your real password) |
| `APPLE_TEAM_ID`              | 10-char team ID from developer.apple.com    |

`tauri-action` runs `codesign` + `notarytool` automatically when these are
present. Notarization adds ~5 min to the macOS job.

### Windows (code-signing cert)

| Secret                          | Source                                     |
| ------------------------------- | ------------------------------------------ |
| `WINDOWS_CERTIFICATE`           | base64-encoded `.pfx`                      |
| `WINDOWS_CERTIFICATE_PASSWORD`  | `.pfx` password                            |

For EV certs (hardware token), CI signing isn't possible without a cloud HSM
(e.g. Azure Key Vault + `azuresigntool`). Stick with an OV cert for CI.

### Linux

No signing required for `.AppImage` / `.deb`. (If you publish to a `.deb`
repo later, you'll want a GPG signing key — out of scope for now.)

## Future: in-app auto-update

The Tauri Updater plugin (free, separate from OS code signing) lets the app
check for new releases and apply them in-place. Not wired up yet. To add:

1. Run `pnpm tauri signer generate -w ~/.tauri/novalis.key`. Store the
   private key as the `TAURI_SIGNING_PRIVATE_KEY` GitHub secret; embed the
   public key in `tauri.conf.json` under `plugins.updater.pubkey`.
2. Add `tauri-plugin-updater` (Rust) + `@tauri-apps/plugin-updater` (JS).
3. Host the update manifest (`latest.json`) on GitHub Pages or release
   assets. `tauri-action` can generate it.
4. Add a "Check for updates" item to the app menu / settings.

This is a separate, larger task; track it as its own follow-up.
