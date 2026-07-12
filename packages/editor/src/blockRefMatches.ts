// Pure matchers for first-class block references. Shared by the BlockRef
// decorations, the `((` suggestion, and MarkdownText's serializer so the
// three can never disagree about what is a reference / a marker (the same
// contract embedMatches / mathMatches / WikiLink keep).
//
// Two constructs, both plain Markdown text (no custom node — round-trip stays
// trivial):
//   - a `((^id))` REFERENCE, and
//   - a trailing ` ^id` block-ID MARKER on the line it tags.
// `id` is base36 (`[a-z0-9]`), so neither construct ever needs Markdown
// escaping. The `^` sigil in a reference keeps it unambiguous against ordinary
// `((parenthetical))` prose.

/** Base36 id, 4–32 chars. Kept in one place so the marker/reference/backend
 *  regexes agree on the alphabet. */
const ID = "[a-z0-9]{4,32}";

export interface BlockRefMatch {
  from: number;
  to: number;
  /** The referenced block id (without the `^` sigil). */
  id: string;
}

export interface BlockIdMatch {
  from: number;
  to: number;
  id: string;
}

// `((^id))` reference. Global: reset `lastIndex` before each scan.
const BLOCK_REF_RE = new RegExp(`\\(\\(\\^(${ID})\\)\\)`, "g");

// A trailing ` ^id` marker: whitespace, caret, id, at end of the string. The
// required leading whitespace stops a bare mid-text caret (e.g. inside `$e^{x}$`
// math, which reads `0^{` — no space) from being read as a marker.
const BLOCK_ID_MARKER_RE = new RegExp(`(\\s)\\^(${ID})\\s*$`);

/** Find `((^id))` references within a single text node's string. Pure. */
export function findBlockRefs(text: string): BlockRefMatch[] {
  const out: BlockRefMatch[] = [];
  BLOCK_REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_REF_RE.exec(text)) !== null) {
    out.push({ from: m.index, to: m.index + m[0].length, id: m[1] });
  }
  return out;
}

/** Find the trailing ` ^id` block-ID marker in a string, or null. The span runs
 *  from the leading space through the end of the id (excluding any trailing
 *  whitespace) so the whole ` ^id` run is decorated/hidden as one unit. Pure. */
export function findBlockId(text: string): BlockIdMatch | null {
  const m = BLOCK_ID_MARKER_RE.exec(text);
  if (!m) return null;
  const from = m.index; // the leading whitespace
  const to = m.index + m[1].length + 1 + m[2].length; // ` ` + `^` + id
  return { from, to, id: m[2] };
}

/** A short base36 block id (6 chars). Content-independent, so the block it
 *  tags keeps the same id across heading renames and text edits. */
export function newBlockId(): string {
  let id = "";
  while (id.length < 6) id += Math.random().toString(36).slice(2);
  return id.slice(0, 6);
}
