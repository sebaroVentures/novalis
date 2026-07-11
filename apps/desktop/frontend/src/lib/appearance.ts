// Applies appearance preferences (theme / accent / font-size / density) to the
// document root via CSS variables + data-* attributes. The semantic color
// tokens in styles.css resolve against these, so this re-themes the whole app
// with no component changes. Called at app mount and on every appearance change.

import type { AppearancePrefs } from "../ipc/api";
import { COLOR_HEX } from "./colors";
import { applyThemePreset, loadThemePreset } from "./themePreset";

export const DEFAULT_APPEARANCE: Required<AppearancePrefs> = {
  theme: "dark",
  accent: "indigo",
  fontSize: 16,
  density: "comfortable",
};

function resolveTheme(theme: string): "dark" | "light" {
  if (theme === "light" || theme === "dark") return theme;
  // "system"
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyAppearance(a: Partial<AppearancePrefs> | undefined | null): void {
  const ap = { ...DEFAULT_APPEARANCE, ...(a ?? {}) };
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(ap.theme);
  root.style.setProperty("--accent", COLOR_HEX[ap.accent] ?? COLOR_HEX.indigo);
  root.style.fontSize = `${ap.fontSize}px`;
  root.dataset.density = ap.density;
  // The preset is device-local (not part of `a`); re-assert it on every apply so
  // it survives a mount or an accent/theme change without a separate call site.
  applyThemePreset(loadThemePreset());
}

/** Re-apply when the OS color scheme changes, but only while theme is "system".
 *  Returns a cleanup function. */
export function watchSystemTheme(
  getAppearance: () => Partial<AppearancePrefs> | undefined | null,
): () => void {
  const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mq) return () => {};
  const handler = () => {
    const a = getAppearance();
    if ((a?.theme ?? DEFAULT_APPEARANCE.theme) === "system") applyAppearance(a);
  };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
