// Parse a RAG answer into text + citation segments. The backend prompt tells
// the model to cite passages with the exact token `[[n]]` (see
// `novalis_core::ai::rag::format_citation`); here we split the streamed answer
// on those tokens so the panel can render each as a clickable chip that opens
// the cited note. Kept pure + unit-tested — the same "citation formatting/
// parsing" contract the Rust side tests from its end.

export type AnswerSegment =
  | { kind: "text"; text: string }
  | { kind: "citation"; id: number };

// `[[12]]` → capture the number. Global so we can walk every match.
const CITATION_RE = /\[\[(\d+)\]\]/g;

/** Split `text` into ordered text / citation segments. Consecutive citations
 *  (`[[1]][[2]]`) yield adjacent citation segments with no empty text between.
 *  Numbers are returned as-is; the caller validates them against its citation
 *  list (an out-of-range `[[9]]` should render as plain text, not a dead link). */
export function parseAnswer(text: string): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(CITATION_RE)) {
    const start = m.index ?? 0;
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    segments.push({ kind: "citation", id: Number(m[1]) });
    last = start + m[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}
