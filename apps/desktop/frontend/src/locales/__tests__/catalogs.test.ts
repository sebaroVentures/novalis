// Gate D of the i18n completeness checks: structural guarantees on the catalogs.
// A key extracted by i18next-parser but never given a value would have an empty
// string here — that's a forgotten translation, and this fails it. The parity
// block additionally proves every non-English locale mirrors English exactly:
// same keys (nothing left untranslated, no orphans), same interpolation
// variables, and the same rich-text markup tags.
import { describe, expect, it } from "vitest";

import deCalendar from "../de/calendar.json";
import deCommon from "../de/common.json";
import deConflict from "../de/conflict.json";
import deEditor from "../de/editor.json";
import deLinks from "../de/links.json";
import deOnboarding from "../de/onboarding.json";
import deSettings from "../de/settings.json";
import deSidebar from "../de/sidebar.json";
import deTasks from "../de/tasks.json";
import deToday from "../de/today.json";
import deTrash from "../de/trash.json";
import deVault from "../de/vault.json";
import deVersions from "../de/versions.json";
import esCalendar from "../es/calendar.json";
import esCommon from "../es/common.json";
import esConflict from "../es/conflict.json";
import esEditor from "../es/editor.json";
import esLinks from "../es/links.json";
import esOnboarding from "../es/onboarding.json";
import esSettings from "../es/settings.json";
import esSidebar from "../es/sidebar.json";
import esTasks from "../es/tasks.json";
import esToday from "../es/today.json";
import esTrash from "../es/trash.json";
import esVault from "../es/vault.json";
import esVersions from "../es/versions.json";
import frCalendar from "../fr/calendar.json";
import frCommon from "../fr/common.json";
import frConflict from "../fr/conflict.json";
import frEditor from "../fr/editor.json";
import frLinks from "../fr/links.json";
import frOnboarding from "../fr/onboarding.json";
import frSettings from "../fr/settings.json";
import frSidebar from "../fr/sidebar.json";
import frTasks from "../fr/tasks.json";
import frToday from "../fr/today.json";
import frTrash from "../fr/trash.json";
import frVault from "../fr/vault.json";
import frVersions from "../fr/versions.json";
import calendar from "../en/calendar.json";
import common from "../en/common.json";
import conflict from "../en/conflict.json";
import editor from "../en/editor.json";
import links from "../en/links.json";
import onboarding from "../en/onboarding.json";
import settings from "../en/settings.json";
import sidebar from "../en/sidebar.json";
import tasks from "../en/tasks.json";
import today from "../en/today.json";
import trash from "../en/trash.json";
import vault from "../en/vault.json";
import versions from "../en/versions.json";

const CATALOGS: Record<string, unknown> = {
  common,
  settings,
  onboarding,
  sidebar,
  calendar,
  tasks,
  today,
  editor,
  vault,
  trash,
  conflict,
  versions,
  links,
};

/** Non-English locales, keyed by namespace, checked for parity against English. */
const LOCALES: Record<string, Record<string, unknown>> = {
  de: {
    common: deCommon,
    settings: deSettings,
    onboarding: deOnboarding,
    sidebar: deSidebar,
    calendar: deCalendar,
    tasks: deTasks,
    today: deToday,
    editor: deEditor,
    vault: deVault,
    trash: deTrash,
    conflict: deConflict,
    versions: deVersions,
    links: deLinks,
  },
  fr: {
    common: frCommon,
    settings: frSettings,
    onboarding: frOnboarding,
    sidebar: frSidebar,
    calendar: frCalendar,
    tasks: frTasks,
    today: frToday,
    editor: frEditor,
    vault: frVault,
    trash: frTrash,
    conflict: frConflict,
    versions: frVersions,
    links: frLinks,
  },
  es: {
    common: esCommon,
    settings: esSettings,
    onboarding: esOnboarding,
    sidebar: esSidebar,
    calendar: esCalendar,
    tasks: esTasks,
    today: esToday,
    editor: esEditor,
    vault: esVault,
    trash: esTrash,
    conflict: esConflict,
    versions: esVersions,
    links: esLinks,
  },
};

/** Every leaf string value with its dotted key path. */
function leaves(node: unknown, prefix = ""): { path: string; value: string }[] {
  if (typeof node === "string") return [{ path: prefix, value: node }];
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) =>
      leaves(v, prefix ? `${prefix}.${k}` : k),
    );
  }
  return [];
}

describe("en catalogs", () => {
  for (const [ns, cat] of Object.entries(CATALOGS)) {
    it(`${ns}: has no empty string values`, () => {
      const empty = leaves(cat)
        .filter((l) => l.value.trim() === "")
        .map((l) => l.path);
      expect(empty, `untranslated keys in ${ns}: ${empty.join(", ")}`).toEqual([]);
    });

    it(`${ns}: interpolation placeholders are balanced`, () => {
      const unbalanced = leaves(cat)
        .filter((l) => {
          const open = (l.value.match(/\{\{/g) ?? []).length;
          const close = (l.value.match(/\}\}/g) ?? []).length;
          return open !== close;
        })
        .map((l) => l.path);
      expect(unbalanced, `unbalanced {{…}} in ${ns}: ${unbalanced.join(", ")}`).toEqual([]);
    });
  }
});

/** Sorted interpolation variables (`{{x}}`) referenced by a message. */
function vars(value: string): string[] {
  return (value.match(/\{\{[^}]*\}\}/g) ?? []).sort();
}

/** Sorted rich-text markup tags (`<b>`, `<1>`, `</2>`…) used by a message. */
function tags(value: string): string[] {
  return (value.match(/<\/?[^>]+>/g) ?? []).sort();
}

for (const [locale, namespaces] of Object.entries(LOCALES)) {
  describe(`${locale} catalogs mirror en`, () => {
    for (const [ns, cat] of Object.entries(CATALOGS)) {
      const enLeaves = leaves(cat);
      const trans = namespaces[ns];

      it(`${ns}: has the same keys as en (nothing untranslated, no orphans)`, () => {
        const enKeys = enLeaves.map((l) => l.path).sort();
        const deKeys = leaves(trans)
          .map((l) => l.path)
          .sort();
        expect(deKeys).toEqual(enKeys);
      });

      it(`${ns}: has no empty string values`, () => {
        const empty = leaves(trans)
          .filter((l) => l.value.trim() === "")
          .map((l) => l.path);
        expect(empty, `untranslated keys in ${locale}/${ns}: ${empty.join(", ")}`).toEqual([]);
      });

      it(`${ns}: preserves interpolation variables and markup per key`, () => {
        const deByPath = new Map(leaves(trans).map((l) => [l.path, l.value]));
        const mismatches: string[] = [];
        for (const { path, value } of enLeaves) {
          const dv = deByPath.get(path);
          if (dv === undefined) continue; // missing-key parity is asserted above
          if (vars(value).join() !== vars(dv).join()) mismatches.push(`${path} (vars)`);
          if (tags(value).join() !== tags(dv).join()) mismatches.push(`${path} (markup)`);
        }
        expect(mismatches, `placeholder/markup drift in ${locale}/${ns}`).toEqual([]);
      });
    }
  });
}
