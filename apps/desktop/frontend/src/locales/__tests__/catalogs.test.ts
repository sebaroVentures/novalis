// Gate D of the i18n completeness checks: structural guarantees on the catalogs.
// A key extracted by i18next-parser but never given a value would have an empty
// string here — that's a forgotten translation, and this fails it. The parity
// block additionally proves every non-English locale mirrors English exactly:
// same keys (nothing left untranslated, no orphans), same interpolation
// variables, and the same rich-text markup tags.
import { describe, expect, it } from "vitest";

import deCalendar from "../de/calendar.json";
import deCommon from "../de/common.json";
import deEditor from "../de/editor.json";
import deSettings from "../de/settings.json";
import deSidebar from "../de/sidebar.json";
import deTasks from "../de/tasks.json";
import deVault from "../de/vault.json";
import esCalendar from "../es/calendar.json";
import esCommon from "../es/common.json";
import esEditor from "../es/editor.json";
import esSettings from "../es/settings.json";
import esSidebar from "../es/sidebar.json";
import esTasks from "../es/tasks.json";
import esVault from "../es/vault.json";
import frCalendar from "../fr/calendar.json";
import frCommon from "../fr/common.json";
import frEditor from "../fr/editor.json";
import frSettings from "../fr/settings.json";
import frSidebar from "../fr/sidebar.json";
import frTasks from "../fr/tasks.json";
import frVault from "../fr/vault.json";
import calendar from "../en/calendar.json";
import common from "../en/common.json";
import editor from "../en/editor.json";
import settings from "../en/settings.json";
import sidebar from "../en/sidebar.json";
import tasks from "../en/tasks.json";
import vault from "../en/vault.json";

const CATALOGS: Record<string, unknown> = {
  common,
  settings,
  sidebar,
  calendar,
  tasks,
  editor,
  vault,
};

/** Non-English locales, keyed by namespace, checked for parity against English. */
const LOCALES: Record<string, Record<string, unknown>> = {
  de: {
    common: deCommon,
    settings: deSettings,
    sidebar: deSidebar,
    calendar: deCalendar,
    tasks: deTasks,
    editor: deEditor,
    vault: deVault,
  },
  fr: {
    common: frCommon,
    settings: frSettings,
    sidebar: frSidebar,
    calendar: frCalendar,
    tasks: frTasks,
    editor: frEditor,
    vault: frVault,
  },
  es: {
    common: esCommon,
    settings: esSettings,
    sidebar: esSidebar,
    calendar: esCalendar,
    tasks: esTasks,
    editor: esEditor,
    vault: esVault,
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
