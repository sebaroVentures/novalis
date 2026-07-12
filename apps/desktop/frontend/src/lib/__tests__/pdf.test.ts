import { describe, expect, it } from "vitest";

import type { PdfHighlight } from "../../ipc/bindings";
import {
  dedupeRects,
  formatHighlightLink,
  formatHighlightSnippet,
  highlightColorHex,
  normalizeRect,
  pdfBasename,
} from "../pdf";

const hl = (over: Partial<PdfHighlight> = {}): PdfHighlight => ({
  id: "id1",
  page: 4,
  color: "yellow",
  text: "quoted line one\nline two",
  note: null,
  rects: [],
  linkedNotes: [],
  created: "2026-07-12T00:00:00Z",
  ...over,
});

describe("pdf helpers", () => {
  it("resolves color tokens with a fallback", () => {
    expect(highlightColorHex("green")).toBe("#4ade80");
    expect(highlightColorHex("unknown")).toBe(highlightColorHex("yellow"));
  });

  it("takes a path basename", () => {
    expect(pdfBasename("docs/sub/paper.pdf")).toBe("paper.pdf");
    expect(pdfBasename("paper.pdf")).toBe("paper.pdf");
  });

  it("normalizes a client rect into 0..1 page space", () => {
    const r = normalizeRect(
      { left: 110, top: 220, width: 60, height: 10 },
      { left: 100, top: 200, width: 200, height: 400 },
    );
    expect(r).toEqual({ x: 0.05, y: 0.05, width: 0.3, height: 0.025 });
  });

  it("drops tiny rects and dedupes near-identical ones", () => {
    const rects = dedupeRects([
      { x: 0.1, y: 0.1, width: 0.3, height: 0.02 },
      { x: 0.1, y: 0.1, width: 0.3, height: 0.02 }, // duplicate
      { x: 0.5, y: 0.5, width: 0.0001, height: 0.0001 }, // degenerate
    ]);
    expect(rects).toHaveLength(1);
  });

  // Byte-for-byte parity with Rust novalis_core::pdf (see its snippet test).
  it("formats the link and snippet exactly like the Rust side", () => {
    expect(formatHighlightLink("docs/paper.pdf", hl())).toBe(
      "[paper.pdf p.4](docs/paper.pdf#hl=id1)",
    );
    expect(formatHighlightSnippet("docs/paper.pdf", hl())).toBe(
      "> quoted line one\n> line two\n>\n> — [paper.pdf p.4](docs/paper.pdf#hl=id1)",
    );
    expect(formatHighlightSnippet("docs/paper.pdf", hl({ note: "my thought" }))).toBe(
      "> quoted line one\n> line two\n>\n> — [paper.pdf p.4](docs/paper.pdf#hl=id1) — my thought",
    );
  });
});
