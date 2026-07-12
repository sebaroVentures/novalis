// Pure helpers for the PDF viewer (feature W4.2): the highlighter palette,
// selection-rect geometry, and the clipboard link/snippet formatters.
//
// The formatters MIRROR the Rust `novalis_core::pdf::{highlight_link,
// highlight_snippet}` byte-for-byte (see that module's tests): the note-insert
// path formats server-side via `link_highlight_to_note`, and these produce the
// identical text for the "copy link"/"copy quote" clipboard actions. Keep them
// in lock-step — the vitest below pins the expected output.

import type { PdfHighlight, PdfRect } from "../ipc/bindings";

/** Translucent highlighter palette (token → hex). The stored annotation keeps
 *  the token; the viewer paints it at low opacity so text stays readable. */
export const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "#facc15",
  green: "#4ade80",
  blue: "#60a5fa",
  pink: "#f472b6",
  purple: "#c084fc",
};

export const HIGHLIGHT_COLOR_TOKENS = Object.keys(HIGHLIGHT_COLORS);
export const DEFAULT_HIGHLIGHT_COLOR = "yellow";

/** Resolve a color token to hex, falling back to the default for an unknown token. */
export function highlightColorHex(token: string): string {
  return HIGHLIGHT_COLORS[token] ?? HIGHLIGHT_COLORS[DEFAULT_HIGHLIGHT_COLOR];
}

/** Basename of a vault-relative (forward-slashed) path. */
export function pdfBasename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Project a client-space rectangle into normalized (0..1) page coordinates,
 *  relative to the page element's own box. Storing normalized rects makes a
 *  highlight independent of zoom/DPI so it re-projects onto any render scale. */
export function normalizeRect(rect: Box, page: Box): PdfRect {
  return {
    x: (rect.left - page.left) / page.width,
    y: (rect.top - page.top) / page.height,
    width: rect.width / page.width,
    height: rect.height / page.height,
  };
}

/** Drop degenerate (near-zero-area) rects and collapse near-duplicates that a
 *  browser's `Range.getClientRects()` can emit for one visual line. */
export function dedupeRects(rects: PdfRect[]): PdfRect[] {
  const out: PdfRect[] = [];
  const seen = new Set<string>();
  const num = (n: number | null) => n ?? 0;
  for (const r of rects) {
    const w = num(r.width);
    const h = num(r.height);
    if (w < 0.002 || h < 0.002) continue;
    const k = [num(r.x), num(r.y), w, h].map((n) => n.toFixed(4)).join(",");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** The inline markdown link back to a highlight — mirror of Rust `highlight_link`. */
export function formatHighlightLink(pdfPath: string, hl: PdfHighlight): string {
  return `[${pdfBasename(pdfPath)} p.${hl.page}](${pdfPath}#hl=${hl.id})`;
}

/** The full quote + back-link block — mirror of Rust `highlight_snippet`. */
export function formatHighlightSnippet(pdfPath: string, hl: PdfHighlight): string {
  const quoted = hl.text
    .trim()
    .split("\n")
    .map((l) => `> ${l}`.replace(/\s+$/, ""))
    .join("\n");
  let out = `${quoted}\n>\n> — ${formatHighlightLink(pdfPath, hl)}`;
  const note = hl.note?.trim();
  if (note) out += ` — ${note}`;
  return out;
}
