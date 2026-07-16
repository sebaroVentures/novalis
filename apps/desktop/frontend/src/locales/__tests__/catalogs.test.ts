// Gate D of the i18n completeness checks: structural guarantees on the catalogs.
// A key extracted by i18next-parser but never given a value would have an empty
// string here — that's a forgotten translation, and this fails it. The parity
// block additionally proves every non-English locale mirrors English exactly:
// same keys (nothing left untranslated, no orphans), same interpolation
// variables, and the same rich-text markup tags.
//
// Catalogs are discovered from the filesystem via import.meta.glob so a new
// namespace or locale can never be silently omitted from these checks. The
// discovery block below cross-checks the found set against the app's
// registration (NAMESPACES / SUPPORTED_LANGUAGES) so a vacuous empty-glob
// pass is impossible.
import { describe, expect, it } from "vitest";

import { NAMESPACES } from "../../lib/i18n";
import { SUPPORTED_LANGUAGES } from "../../lib/language";

// Every catalog under src/locales/<locale>/<namespace>.json, eagerly imported.
const modules = import.meta.glob("../*/*.json", { eager: true, import: "default" }) as Record<
  string,
  unknown
>;

const byLocale: Record<string, Record<string, unknown>> = {};
for (const [file, catalog] of Object.entries(modules)) {
  const m = /^\.\.\/([^/]+)\/([^/]+)\.json$/.exec(file);
  if (!m) throw new Error(`unexpected catalog path: ${file}`);
  const [, locale, ns] = m;
  (byLocale[locale] ??= {})[ns] = catalog;
}

const CATALOGS: Record<string, unknown> = byLocale.en ?? {};

/** Non-English locales, keyed by namespace, checked for parity against English. */
const { en: _en, ...LOCALES } = byLocale;

describe("catalog discovery", () => {
  // The dev-only pseudo-locale (en-XA) is generated at runtime and ships no files.
  const realLocales = SUPPORTED_LANGUAGES.filter((l) => l !== "en-XA");

  it("finds every supported locale on disk", () => {
    expect(Object.keys(byLocale).sort()).toEqual([...realLocales].sort());
  });

  for (const locale of realLocales) {
    it(`${locale}: ships exactly the registered namespaces`, () => {
      expect(Object.keys(byLocale[locale] ?? {}).sort()).toEqual([...NAMESPACES].sort());
    });
  }
});

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
