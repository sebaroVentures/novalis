// Shared by Math and Embed: both reveal a span's raw source while the
// selection touches it, so their decorations depend on the selection only
// through "which spans does it overlap". Rebuilding the whole DecorationSet on
// every cursor move (two doc walks + regex per arrow key) is wasteful — the
// plugins rebuild only when this overlap changes and otherwise carry the set
// forward untouched (with no doc change the transaction mapping is empty, so
// mapping the set would be an identity anyway).

export interface Span {
  from: number;
  to: number;
}

interface SelectionLike {
  from: number;
  to: number;
}

/** Did moving the selection change which spans are cursor-revealed? Uses the
 *  same inclusive overlap test as the builders (`sel.from <= span.to &&
 *  sel.to >= span.from`). */
export function spanOverlapChanged(
  spans: readonly Span[],
  oldSel: SelectionLike,
  newSel: SelectionLike,
): boolean {
  for (const span of spans) {
    const before = oldSel.from <= span.to && oldSel.to >= span.from;
    const after = newSel.from <= span.to && newSel.to >= span.from;
    if (before !== after) return true;
  }
  return false;
}
