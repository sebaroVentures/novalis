// i18next initialization. Runs synchronously at module load (imported first in
// main.tsx, before <App/>) so the chosen language is active on first paint and
// there is no flash of untranslated content. English catalogs are bundled, so
// there's no async resource loading and no need for React Suspense.

import i18n, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";

import deCalendar from "../locales/de/calendar.json";
import deCommon from "../locales/de/common.json";
import deEditor from "../locales/de/editor.json";
import deSettings from "../locales/de/settings.json";
import deSidebar from "../locales/de/sidebar.json";
import deTasks from "../locales/de/tasks.json";
import deVault from "../locales/de/vault.json";
import esCalendar from "../locales/es/calendar.json";
import esCommon from "../locales/es/common.json";
import esEditor from "../locales/es/editor.json";
import esSettings from "../locales/es/settings.json";
import esSidebar from "../locales/es/sidebar.json";
import esTasks from "../locales/es/tasks.json";
import esVault from "../locales/es/vault.json";
import frCalendar from "../locales/fr/calendar.json";
import frCommon from "../locales/fr/common.json";
import frEditor from "../locales/fr/editor.json";
import frSettings from "../locales/fr/settings.json";
import frSidebar from "../locales/fr/sidebar.json";
import frTasks from "../locales/fr/tasks.json";
import frVault from "../locales/fr/vault.json";
import calendar from "../locales/en/calendar.json";
import common from "../locales/en/common.json";
import editor from "../locales/en/editor.json";
import settings from "../locales/en/settings.json";
import sidebar from "../locales/en/sidebar.json";
import tasks from "../locales/en/tasks.json";
import vault from "../locales/en/vault.json";
import { getLanguage, type LanguageCode } from "./language";

export const NAMESPACES = [
  "common",
  "settings",
  "sidebar",
  "calendar",
  "tasks",
  "editor",
  "vault",
] as const;

// --- dev-only pseudo-locale generation -------------------------------------
// Defined before use so it isn't in the temporal-dead-zone when the resources
// object below is built.

const ACCENTS: Record<string, string> = {
  a: "á", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ǧ", h: "ĥ", i: "í",
  j: "ĵ", k: "ķ", l: "ļ", m: "ɱ", n: "ñ", o: "ó", p: "þ", q: "ǫ", r: "ŕ",
  s: "š", t: "ţ", u: "ú", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "Á", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ǧ", H: "Ĥ", I: "Í",
  J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ", N: "Ñ", O: "Ó", P: "Þ", Q: "Ǫ", R: "Ŕ",
  S: "Š", T: "Ţ", U: "Ú", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

function accentWord(text: string): string {
  let out = "";
  for (const ch of text) out += ACCENTS[ch] ?? ch;
  return out;
}

/** Accent + bracket a message, preserving i18next interpolation (`{{x}}`) and
 *  nesting (`$t(...)`), and padding ~40% so truncation/overflow shows up. */
function pseudoString(value: string): string {
  const parts = value.split(/(\{\{[^}]*\}\}|\$t\([^)]*\))/g);
  const body = parts.map((p, i) => (i % 2 === 0 ? accentWord(p) : p)).join("");
  const pad = "·".repeat(Math.max(2, Math.round(value.replace(/[^A-Za-z]/g, "").length * 0.4)));
  return `⟦${body} ${pad}⟧`;
}

function pseudoize(node: unknown): unknown {
  if (typeof node === "string") return pseudoString(node);
  if (Array.isArray(node)) return node.map(pseudoize);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = pseudoize(v);
    return out;
  }
  return node;
}

// ---------------------------------------------------------------------------

const en = { common, settings, sidebar, calendar, tasks, editor, vault };
const de = {
  common: deCommon,
  settings: deSettings,
  sidebar: deSidebar,
  calendar: deCalendar,
  tasks: deTasks,
  editor: deEditor,
  vault: deVault,
};
const fr = {
  common: frCommon,
  settings: frSettings,
  sidebar: frSidebar,
  calendar: frCalendar,
  tasks: frTasks,
  editor: frEditor,
  vault: frVault,
};
const es = {
  common: esCommon,
  settings: esSettings,
  sidebar: esSidebar,
  calendar: esCalendar,
  tasks: esTasks,
  editor: esEditor,
  vault: esVault,
};

const resources: Resource = { en, de, fr, es };
if (import.meta.env.DEV) {
  resources["en-XA"] = pseudoize(en) as Resource[string];
}

void i18n.use(initReactI18next).init({
  resources,
  lng: getLanguage(),
  fallbackLng: "en",
  defaultNS: "common",
  ns: NAMESPACES,
  interpolation: { escapeValue: false }, // React already escapes; lets {{x}} render raw
  react: { useSuspense: false }, // resources are synchronous — no Suspense needed
  returnNull: false,
});

/** Switch the active language and reflect it on the document element. */
export function applyLanguage(lng: LanguageCode): void {
  void i18n.changeLanguage(lng);
  const root = document.documentElement;
  root.lang = lng === "en-XA" ? "en" : lng; // en-XA has no real CLDR locale
  root.dir = "ltr"; // forward-looking: set to "rtl" when an RTL locale is added
}

export default i18n;
