// Device-local UI language preference. Mirrors the device-pref pattern in
// sidebarPrefs.ts (a `novalis:device:*` localStorage key) and is intentionally
// distinct from the vault-scoped Preferences: the UI language is a property of
// this device/user, must be available before any vault opens (the VaultGate
// renders pre-vault), and should not sync as if it were note content.
//
// `applyLanguage()` (the side-effect that switches i18next + the document) lives
// in lib/i18n.ts, next to the instance, to avoid an import cycle.

/** A language the app can render in. The pseudo-locale is dev-only QA tooling. */
export type LanguageCode = "en" | "de" | "fr" | "es" | "en-XA";

/** Languages offered in the picker. The pseudo-locale ships in dev only — it's a
 *  QA aid for spotting un-translated strings, not a real locale. */
export const SUPPORTED_LANGUAGES: LanguageCode[] = import.meta.env.DEV
  ? ["en", "de", "fr", "es", "en-XA"]
  : ["en", "de", "fr", "es"];

const LANG_KEY = "novalis:device:language";

function isSupported(code: string): code is LanguageCode {
  return (SUPPORTED_LANGUAGES as string[]).includes(code);
}

/** Best-effort match of the browser/OS locale against a real supported language. */
function detectSystemLanguage(): LanguageCode {
  try {
    const candidates = [navigator.language, ...(navigator.languages ?? [])];
    for (const c of candidates) {
      if (!c) continue;
      const base = c.toLowerCase().split("-")[0];
      const hit = SUPPORTED_LANGUAGES.find((l) => l !== "en-XA" && l.split("-")[0] === base);
      if (hit) return hit;
    }
  } catch {
    /* navigator unavailable — fall through to the default */
  }
  return "en";
}

/** The active language: an explicit device choice if set, else the OS locale. */
export function getLanguage(): LanguageCode {
  try {
    const raw = localStorage.getItem(LANG_KEY);
    if (raw && isSupported(raw)) return raw;
  } catch {
    /* localStorage unavailable (private mode) — fall through */
  }
  return detectSystemLanguage();
}

export function setLanguage(lng: LanguageCode): void {
  try {
    localStorage.setItem(LANG_KEY, lng);
  } catch {
    /* ignore quota / privacy-mode errors — the in-memory choice still applies */
  }
}

/** Human-readable name for the picker (endonym, e.g. "English", "Deutsch"). */
export function languageDisplayName(code: LanguageCode): string {
  if (code === "en-XA") return "Pseudo (en-XA)";
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    if (name) return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    /* Intl.DisplayNames unsupported — fall back to the raw code */
  }
  return code;
}
