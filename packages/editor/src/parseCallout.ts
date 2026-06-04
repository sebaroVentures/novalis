export interface CalloutInfo {
  type: string;
  title: string;
}

const CALLOUT_RE = /^\s*\[!([A-Za-z]+)\]\s?(.*)/;
const KNOWN_TYPES = new Set([
  "note",
  "tip",
  "info",
  "warning",
  "danger",
  "success",
  "question",
  "quote",
  "caution",
  "important",
  "error",
]);

/** Parse an Obsidian-style callout marker (`[!type] optional title`) from the
 *  start of a blockquote's text. Unknown types fall back to `note`. Returns
 *  null when the text is not a callout. Pure — unit-testable. */
export function parseCallout(text: string): CalloutInfo | null {
  const m = CALLOUT_RE.exec(text);
  if (!m) return null;
  const raw = m[1].toLowerCase();
  return { type: KNOWN_TYPES.has(raw) ? raw : "note", title: m[2].trim() };
}
