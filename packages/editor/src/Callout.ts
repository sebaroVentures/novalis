import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { changedBlockRanges, patchDecorations } from "./incrementalDecorations";
import { parseCallout } from "./parseCallout";

/** Exported so the incremental-decoration test can read the live set (matches
 *  Find's `findPluginKey`). Not part of the package's public surface. */
export const calloutKey = new PluginKey("nvCallout");

/** Decorate every blockquote whose first line is `[!type] …` as a callout box.
 *  Decoration-only: the document stays a plain blockquote, so the `> [!NOTE]`
 *  Markdown round-trips untouched (mirrors the WikiLink approach). */
const MARKER_RE = /^\[![^\]\n]*\]/;

/** Scan `[from, to)` and return the callout decorations in it. Used for both the
 *  initial full build (`0 … doc.content.size`) and the incremental per-block
 *  patch, so the two paths can't disagree. A callout's node decoration spans a
 *  whole blockquote and its marker decoration is line-local, so neither crosses
 *  a top-level block boundary. */
function scanCallouts(doc: ProseMirrorNode, from: number, to: number): Decoration[] {
  const decos: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === "blockquote") {
      const info = parseCallout(node.textContent);
      if (info) {
        decos.push(
          Decoration.node(pos, pos + node.nodeSize, {
            class: `nv-callout nv-callout-${info.type}`,
            "data-callout": info.type,
          }),
        );
      }
      return;
    }
    // Tag the `[!TYPE]` marker (the run at a text node's start) so reading mode
    // can dim it via CSS — same position approach as WikiLink. No effect while
    // editing.
    if (!node.isText) return;
    const m = MARKER_RE.exec(node.text ?? "");
    if (m) decos.push(Decoration.inline(pos, pos + m[0].length, { class: "nv-callout-marker" }));
  });
  return decos;
}

function build(doc: ProseMirrorNode): DecorationSet {
  return DecorationSet.create(doc, scanCallouts(doc, 0, doc.content.size));
}

export const Callout = Extension.create({
  name: "nvCallout",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: calloutKey,
        state: {
          init: (_config, state) => build(state.doc),
          // Selection-only transactions do no work; a doc change maps the
          // existing set forward and re-scans only the blocks that changed
          // (expanded to whole blockquotes so split/join is covered), which
          // yields the same set as a full rebuild far more cheaply.
          apply: (tr, old) => {
            if (!tr.docChanged) return old;
            const mapped = old.map(tr.mapping, tr.doc);
            return patchDecorations(mapped, tr.doc, changedBlockRanges(tr), (from, to) =>
              scanCallouts(tr.doc, from, to),
            );
          },
        },
        props: {
          decorations(state) {
            return calloutKey.getState(state) as DecorationSet;
          },
        },
      }),
    ];
  },
});
