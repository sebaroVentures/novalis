// Formats an unexpected error for display. The underlying text comes from the
// Rust backend and intentionally stays in English (it's diagnostic — useful
// verbatim in a bug report); only the locale-specific prefix
// (`common:errorPrefix`, e.g. "Error: " / "Fehlermeldung: ") marks where it
// comes from. Friendly, fully-localized messages (e.g. name collisions) are
// produced at their call sites with `i18n.t` and do NOT go through here.

import i18n from "./i18n";

export function displayError(e: unknown): string {
  // Prefer the bare message (e.g. "not found: foo.md") over `String(e)`, which
  // would prepend the "NovalisError:" class name — noise behind our own prefix.
  const message = e instanceof Error ? e.message : String(e);
  return i18n.t("common:errorPrefix") + message;
}
