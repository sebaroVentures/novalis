#!/usr/bin/env node
// Verifies the three release version stamps stay in sync (see RELEASING.md):
//   - package.json                            → version
//   - Cargo.toml                              → [workspace.package] version
//   - apps/desktop/src-tauri/tauri.conf.json  → version
// Exits non-zero (and prints all three) on any mismatch. No dependencies.

import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const packageJson = JSON.parse(read("package.json")).version;
const tauriConf = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")).version;

// First `version = "…"` after the [workspace.package] section header.
const cargoMatch = read("Cargo.toml").match(
  /^\[workspace\.package\][^[]*?^version\s*=\s*"([^"]+)"/ms,
);
const cargoToml = cargoMatch?.[1];

const stamps = {
  "package.json": packageJson,
  "Cargo.toml [workspace.package]": cargoToml,
  "apps/desktop/src-tauri/tauri.conf.json": tauriConf,
};

const values = Object.values(stamps);
if (values.some((v) => !v) || new Set(values).size !== 1) {
  console.error("Version stamps are out of sync (see RELEASING.md):");
  for (const [file, version] of Object.entries(stamps)) {
    console.error(`  ${file}: ${version ?? "NOT FOUND"}`);
  }
  process.exit(1);
}

console.log(`Version stamps in sync: ${values[0]}`);
