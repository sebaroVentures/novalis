// Shared by the decoration-only plugins whose sets depend purely on the doc
// (WikiLink, Callout): instead of discarding the whole DecorationSet and walking
// every text node on each keystroke, map the existing set through the
// transaction and re-scan only the blocks that actually changed. The result is
// identical to a full rebuild — the plugins keep a single `scan(from, to)` used
// for both the initial full build and the incremental patch, so the two can't
// drift.
//
// Only safe for plugins whose decorations (a) never cross a top-level block
// boundary and (b) don't depend on doc-global counters (that rules out the
// occurrence-indexed widget keys in Math/Embed/BlockRef — see their `apply`).

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import type { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface DecoRange {
  from: number;
  to: number;
}

/** Whole top-level (doc-child) block ranges in `tr.doc` that overlap any region
 *  changed by `tr`. Over-covering is always safe — rescanning extra blocks only
 *  costs time — while under-covering would drop decorations, so each changed
 *  range is grown by one position on each side before being snapped out to whole
 *  blocks. That extra position catches edits that land exactly on a block
 *  boundary (a split or a join), pulling in the neighbour on each side. */
export function changedBlockRanges(tr: Transaction): DecoRange[] {
  const doc = tr.doc;
  const size = doc.content.size;
  const clamp = (n: number) => (n < 0 ? 0 : n > size ? size : n);
  const spans: DecoRange[] = [];
  const maps = tr.mapping.maps;
  for (let i = 0; i < maps.length; i++) {
    // `newStart`/`newEnd` are in the doc produced by step `i`; map them through
    // the remaining steps to reach `tr.doc` coordinates.
    maps[i].forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      const rest = tr.mapping.slice(i + 1);
      const a = rest.map(newStart, -1);
      const b = rest.map(newEnd, 1);
      const $from = doc.resolve(clamp(Math.min(a, b) - 1));
      const $to = doc.resolve(clamp(Math.max(a, b) + 1));
      spans.push({
        from: $from.depth >= 1 ? $from.before(1) : 0,
        to: $to.depth >= 1 ? $to.after(1) : size,
      });
    });
  }
  if (spans.length === 0) return [];
  spans.sort((x, y) => x.from - y.from);
  const merged: DecoRange[] = [{ ...spans[0] }];
  for (let i = 1; i < spans.length; i++) {
    const last = merged[merged.length - 1];
    if (spans[i].from <= last.to) last.to = Math.max(last.to, spans[i].to);
    else merged.push({ ...spans[i] });
  }
  return merged;
}

/** Replace the plugin's decorations within `ranges` with a fresh scan of those
 *  ranges, leaving decorations elsewhere (already position-mapped) untouched.
 *  Removal is keyed on each decoration's start position with a half-open
 *  `[from, to)` test so a node decoration whose block starts exactly at a range
 *  boundary is attributed to a single range — matching `scan`, which emits
 *  decorations anchored in the same half-open interval. */
export function patchDecorations(
  mapped: DecorationSet,
  doc: ProseMirrorNode,
  ranges: DecoRange[],
  scan: (from: number, to: number) => Decoration[],
): DecorationSet {
  let set = mapped;
  for (const r of ranges) {
    const stale = set.find(r.from, r.to).filter((d) => d.from >= r.from && d.from < r.to);
    if (stale.length) set = set.remove(stale);
    const fresh = scan(r.from, r.to);
    if (fresh.length) set = set.add(doc, fresh);
  }
  return set;
}
