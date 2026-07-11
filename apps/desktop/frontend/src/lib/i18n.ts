// i18next initialization. Runs synchronously at module load (imported first in
// main.tsx, before <App/>) so the chosen language is active on first paint and
// there is no flash of untranslated content. English catalogs are bundled, so
// there's no async resource loading and no need for React Suspense.

import i18n, { type Resource } from "i18next";
import { initReactI18next } from "react-i18next";

import deAi from "../locales/de/ai.json";
import deCalendar from "../locales/de/calendar.json";
import deCommon from "../locales/de/common.json";
import deConflict from "../locales/de/conflict.json";
import deEditor from "../locales/de/editor.json";
import deLinks from "../locales/de/links.json";
import deOnboarding from "../locales/de/onboarding.json";
import deSettings from "../locales/de/settings.json";
import deSidebar from "../locales/de/sidebar.json";
import deTasks from "../locales/de/tasks.json";
import deToday from "../locales/de/today.json";
import deTrash from "../locales/de/trash.json";
import deVault from "../locales/de/vault.json";
import deVersions from "../locales/de/versions.json";
import esAi from "../locales/es/ai.json";
import esCalendar from "../locales/es/calendar.json";
import esCommon from "../locales/es/common.json";
import esConflict from "../locales/es/conflict.json";
import esEditor from "../locales/es/editor.json";
import esLinks from "../locales/es/links.json";
import esOnboarding from "../locales/es/onboarding.json";
import esSettings from "../locales/es/settings.json";
import esSidebar from "../locales/es/sidebar.json";
import esTasks from "../locales/es/tasks.json";
import esToday from "../locales/es/today.json";
import esTrash from "../locales/es/trash.json";
import esVault from "../locales/es/vault.json";
import esVersions from "../locales/es/versions.json";
import frAi from "../locales/fr/ai.json";
import frCalendar from "../locales/fr/calendar.json";
import frCommon from "../locales/fr/common.json";
import frConflict from "../locales/fr/conflict.json";
import frEditor from "../locales/fr/editor.json";
import frLinks from "../locales/fr/links.json";
import frOnboarding from "../locales/fr/onboarding.json";
import frSettings from "../locales/fr/settings.json";
import frSidebar from "../locales/fr/sidebar.json";
import frTasks from "../locales/fr/tasks.json";
import frToday from "../locales/fr/today.json";
import frTrash from "../locales/fr/trash.json";
import frVault from "../locales/fr/vault.json";
import frVersions from "../locales/fr/versions.json";
import ai from "../locales/en/ai.json";
import calendar from "../locales/en/calendar.json";
import common from "../locales/en/common.json";
import conflict from "../locales/en/conflict.json";
import editor from "../locales/en/editor.json";
import links from "../locales/en/links.json";
import onboarding from "../locales/en/onboarding.json";
import settings from "../locales/en/settings.json";
import sidebar from "../locales/en/sidebar.json";
import tasks from "../locales/en/tasks.json";
import today from "../locales/en/today.json";
import trash from "../locales/en/trash.json";
import vault from "../locales/en/vault.json";
import versions from "../locales/en/versions.json";
import { getLanguage, type LanguageCode } from "./language";

export const NAMESPACES = [
  "common",
  "ai",
  "settings",
  "onboarding",
  "sidebar",
  "calendar",
  "tasks",
  "today",
  "editor",
  "vault",
  "trash",
  "conflict",
  "versions",
  "links",
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

const en = { common, ai, settings, onboarding, sidebar, calendar, tasks, today, editor, vault, trash, conflict, versions, links };
const de = {
  common: deCommon,
  ai: deAi,
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
};
const fr = {
  common: frCommon,
  ai: frAi,
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
};
const es = {
  common: esCommon,
  ai: esAi,
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
