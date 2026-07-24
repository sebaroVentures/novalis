// The REAL gate for the Feature Guide's dynamic i18n keys. Every help string
// resolves at runtime via t(`${topic.keyBase}…`) / t(row.descKey), which
// i18next-parser cannot see — the keep-alive comments in registry.ts only stop
// the extractor from *deleting* the keys. THIS test is what proves registry ↔
// en/help.json stay in sync, in both directions (the catalogs test then
// propagates en's shape to de/es/fr by key parity).
import { describe, expect, it, vi } from "vitest";

// settingsStore (resolveFeaturePrefs) pulls in the ipc module; mock it so no
// Tauri runtime is needed (same pattern as lib/__tests__/features.test.ts).
vi.mock("../../ipc/api", () => ({
  api: { getPreferences: vi.fn(), setPreferences: vi.fn() },
}));

import { DEMO_TOPICS } from "../../ipc/bindings";
import en from "../../locales/en/help.json";
import { resolveFeaturePrefs } from "../../stores/settingsStore";
import { GROUP_LABEL_KEYS, HELP_GROUPS, HELP_TOPICS } from "../registry";

/** The 32 real flag keys, from the same resolver the app uses. */
const FEATURE_KEYS = new Set(Object.keys(resolveFeaturePrefs(undefined)));

/** Leaf lookup of a dotted key in the en help catalog ('' if absent). */
function resolve(key: string): string {
  let node: unknown = en;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return "";
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : "";
}

/** Every leaf string path under a node. */
function leafPaths(node: unknown, prefix = ""): string[] {
  if (typeof node === "string") return [prefix];
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) =>
      leafPaths(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [];
}

describe("help registry ↔ en catalog", () => {
  it("has unique topic ids and keyBase = topics.<id>", () => {
    const ids = HELP_TOPICS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of HELP_TOPICS) expect(t.keyBase).toBe(`topics.${t.id}`);
  });

  it("covers all 32 feature flags plus the two out-of-band gates", () => {
    const byFeature = HELP_TOPICS.filter((t) => t.feature).map((t) => t.feature);
    expect(new Set(byFeature).size).toBe(FEATURE_KEYS.size);
    const gates = HELP_TOPICS.filter((t) => t.customGate).map((t) => t.customGate);
    expect(gates.sort()).toEqual(["ambientAi", "gitSync"]);
  });

  it("every keyBase resolves to non-empty what/where strings in en", () => {
    for (const t of HELP_TOPICS) {
      expect(resolve(`${t.keyBase}.what`), `${t.id}.what`).not.toBe("");
      expect(resolve(`${t.keyBase}.where`), `${t.id}.where`).not.toBe("");
    }
  });

  it("every help-namespace titleKey resolves; gated topics reuse settings labels", () => {
    for (const t of HELP_TOPICS) {
      if (t.titleKey.startsWith("help:")) {
        expect(resolve(t.titleKey.slice("help:".length)), t.id).not.toBe("");
      } else {
        // Cross-namespace names must point at a real settings features label
        // so the guide can never disagree with Settings › Features. The two
        // out-of-band gates reuse the panel's `ambient` / `git` rows.
        const m = /^settings:features\.(\w+)\.label$/.exec(t.titleKey);
        expect(m, `${t.id}: ${t.titleKey}`).not.toBeNull();
        const label = m![1];
        expect(
          FEATURE_KEYS.has(label) || label === "ambient" || label === "git",
          `${t.id}: ${t.titleKey}`,
        ).toBe(true);
      }
    }
  });

  it("every syntax descKey resolves to a non-empty string in en", () => {
    for (const t of HELP_TOPICS) {
      for (const row of t.syntax ?? []) {
        expect(row.descKey, `${t.id} descKey prefix`).toMatch(
          new RegExp(`^${t.keyBase.replace(".", "\\.")}\\.syntax\\.`),
        );
        expect(resolve(row.descKey), row.descKey).not.toBe("");
        expect(row.code, `${t.id} code literal`).not.toBe("");
      }
    }
  });

  it("every topic with a model or token cost has non-empty cost copy", () => {
    for (const t of HELP_TOPICS) {
      if (t.costMb !== undefined || t.tokenCost) {
        expect(resolve(`${t.keyBase}.cost`), `${t.id}.cost`).not.toBe("");
      }
    }
  });

  it("every topics.* key in en is referenced by the registry (no orphans)", () => {
    const allowed = new Set<string>();
    for (const t of HELP_TOPICS) {
      allowed.add(`${t.keyBase}.what`);
      allowed.add(`${t.keyBase}.where`);
      allowed.add(`${t.keyBase}.setup`);
      allowed.add(`${t.keyBase}.cost`);
      if (t.titleKey === `help:${t.keyBase}.title`) allowed.add(`${t.keyBase}.title`);
      for (const row of t.syntax ?? []) allowed.add(row.descKey);
    }
    const orphans = leafPaths(en)
      .filter((p) => p.startsWith("topics.")) // guide.* chrome is exempt
      .filter((p) => !allowed.has(p));
    expect(orphans).toEqual([]);
  });

  it("every feature? is a valid FeatureKey", () => {
    for (const t of HELP_TOPICS) {
      if (t.feature) expect(FEATURE_KEYS.has(t.feature), `${t.id}: ${t.feature}`).toBe(true);
    }
  });

  it("demoTopic values are unique", () => {
    const demos = HELP_TOPICS.filter((t) => t.demoTopic).map((t) => t.demoTopic);
    expect(new Set(demos).size).toBe(demos.length);
  });

  // The cross-language half of the contract. `demoTopic` is TYPED against the
  // generated DEMO_TOPICS tuple, so an id the backend doesn't serve is already
  // a compile error; this covers the other direction — a demo authored in
  // help_demo.rs that no topic ever offers is dead code the guide can't reach.
  // (CI regenerates bindings.ts and fails on drift, so this really does read
  // the Rust list.)
  it("offers every demo topic create_demo_note serves", () => {
    const offered = new Set(HELP_TOPICS.map((t) => t.demoTopic).filter(Boolean));
    expect([...offered].sort()).toEqual([...DEMO_TOPICS].sort());
  });

  it("groups are known and every group heading key exists", () => {
    for (const t of HELP_TOPICS) {
      expect(HELP_GROUPS, t.id).toContain(t.group);
    }
    for (const g of HELP_GROUPS) {
      expect(GROUP_LABEL_KEYS[g], g).toBeTruthy();
    }
    expect(resolve("guide.groups.basics")).not.toBe("");
  });
});
