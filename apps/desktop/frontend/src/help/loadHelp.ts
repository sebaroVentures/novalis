// Lazy loader for the `help` i18n namespace. The Feature Guide's catalogs are
// the largest in the app and only needed once the guide opens, so they stay
// out of the eager bundle (lib/i18n.ts imports every other catalog
// synchronously; `help` is listed there in LAZY_NAMESPACES instead). Vite
// splits each locale's help.json into its own chunk via import.meta.glob.
//
// The dev-only pseudo-locale (en-XA) ships no help.json on disk; it resolves
// as already-loaded and help strings fall through to the English bundle via
// fallbackLng — the one namespace the pseudolocale doesn't accent.

import { useEffect, useState } from "react";

import i18n from "../lib/i18n";

/** `../locales/<lng>/help.json` → lazy importer (one chunk per locale). */
const CATALOGS = import.meta.glob("../locales/*/help.json", {
  import: "default",
}) as Record<string, () => Promise<Record<string, unknown>>>;

/** Languages whose bundle is registered (or known to have no file). */
const loaded = new Set<string>();
const inflight = new Map<string, Promise<void>>();

function loadLanguage(lng: string): Promise<void> {
  if (loaded.has(lng)) return Promise.resolve();
  const pending = inflight.get(lng);
  if (pending) return pending;
  const importer = CATALOGS[`../locales/${lng}/help.json`];
  if (!importer) {
    // No catalog on disk (en-XA) — nothing to add, fallbackLng covers it.
    loaded.add(lng);
    return Promise.resolve();
  }
  const p = importer()
    .then((catalog) => {
      i18n.addResourceBundle(lng, "help", catalog, true, true);
      loaded.add(lng);
    })
    .finally(() => inflight.delete(lng)); // a failed load stays retryable
  inflight.set(lng, p);
  return p;
}

/** True once the help bundles for `lng` (and the en fallback) are registered. */
function helpReady(lng: string): boolean {
  return loaded.has("en") && loaded.has(lng);
}

/** Load the active language's help catalog plus the en fallback. Memoized —
 *  repeat calls (and calls after a language switch to an already-loaded
 *  language) resolve immediately. Rejects if a chunk fails to load. */
export function ensureHelpLoaded(): Promise<void> {
  const lng = i18n.language;
  return Promise.all([loadLanguage("en"), loadLanguage(lng)]).then(() => undefined);
}

/** For lazy components: kicks off the load on mount (and again on language
 *  switch), returns whether `t("help:…")` will resolve translated strings. */
export function useHelpLoaded(): boolean {
  const [ready, setReady] = useState(() => helpReady(i18n.language));
  useEffect(() => {
    let live = true;
    const load = () => {
      const lng = i18n.language;
      setReady(helpReady(lng));
      ensureHelpLoaded()
        .then(() => {
          // A stale resolve (language switched mid-load) must not report
          // ready — the languageChanged re-run owns the new language.
          if (live && i18n.language === lng) setReady(true);
        })
        .catch((e: unknown) => {
          // Loud but non-fatal: the guide renders raw keys until a retry.
          console.error("help catalogs failed to load", e);
        });
    };
    load();
    i18n.on("languageChanged", load);
    return () => {
      live = false;
      i18n.off("languageChanged", load);
    };
  }, []);
  return ready;
}
