// Device-local theme preset: a complete alternate semantic-token palette
// (correct in BOTH light and dark) layered on the dark/light base. The token
// blocks live in styles.css, keyed off `data-theme-preset` × `data-theme`; this
// module just persists the choice and reflects it on the document root.
//
// Stored in localStorage (device-local, global), NOT in the vault-synced
// AppearancePrefs: that is a fixed Rust struct (models/preferences.rs) and an
// added field would be silently dropped by serde on the setPreferences →
// write_preferences round-trip — a Rust change is out of scope here. Mirrors the
// device-pref pattern in lib/uiPrefs.ts.

export const THEME_PRESETS = ["default", "sepia", "nord", "high-contrast"] as const;
export type ThemePreset = (typeof THEME_PRESETS)[number];

export const DEFAULT_PRESET: ThemePreset = "default";

const KEY = "novalis:device:themePreset";

function isPreset(v: string | null): v is ThemePreset {
  return v != null && (THEME_PRESETS as readonly string[]).includes(v);
}

export function loadThemePreset(): ThemePreset {
  try {
    const v = localStorage.getItem(KEY);
    return isPreset(v) ? v : DEFAULT_PRESET;
  } catch {
    return DEFAULT_PRESET;
  }
}

export function saveThemePreset(preset: ThemePreset): void {
  try {
    localStorage.setItem(KEY, preset);
  } catch {
    /* ignore quota errors — the preset is non-critical view state */
  }
}

/** Reflect the preset on <html>. "default" removes the attribute so the neutral
 *  base palette applies unchanged. */
export function applyThemePreset(preset: ThemePreset): void {
  const root = document.documentElement;
  if (preset === DEFAULT_PRESET) delete root.dataset.themePreset;
  else root.dataset.themePreset = preset;
}
