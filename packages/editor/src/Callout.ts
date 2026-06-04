import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { parseCallout } from "./parseCallout";

const calloutKey = new PluginKey("nvCallout");

/** Decorate every blockquote whose first line is `[!type] …` as a callout box.
 *  Decoration-only: the document stays a plain blockquote, so the `> [!NOTE]`
 *  Markdown round-trips untouched (mirrors the WikiLink approach). */
const MARKER_RE = /^\[![^\]\n]*\]/;

function build(doc: ProseMirrorNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "blockquote") return;
    const info = parseCallout(node.textContent);
    if (info) {
      decos.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: `nv-callout nv-callout-${info.type}`,
          "data-callout": info.type,
        }),
      );
    }
  });
  // Tag the `[!TYPE]` marker (the run at a text node's start) so reading mode can
  // dim it via CSS — same position approach as WikiLink. No effect while editing.
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const m = MARKER_RE.exec(node.text ?? "");
    if (m) decos.push(Decoration.inline(pos, pos + m[0].length, { class: "nv-callout-marker" }));
  });
  return DecorationSet.create(doc, decos);
}

export const Callout = Extension.create({
  name: "nvCallout",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: calloutKey,
        state: {
          init: (_config, state) => build(state.doc),
          apply: (tr, old) => (tr.docChanged ? build(tr.doc) : old),
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
