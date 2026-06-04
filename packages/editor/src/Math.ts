import { Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { findMath } from "./mathMatches";

interface KatexLike {
  renderToString(tex: string, options: { displayMode: boolean; throwOnError: boolean }): string;
}

const mathKey = new PluginKey("nvMath");
const htmlCache = new Map<string, string>();
let katex: KatexLike | null = null;
let loading: Promise<void> | null = null;
let pluginView: EditorView | null = null;

// KaTeX (~300 KB) and its CSS are loaded only when a note actually contains
// math. The result HTML per expression is cached so re-decoration is sync.
function ensureKatex(): Promise<void> {
  if (katex) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      const [mod] = await Promise.all([import("katex"), import("katex/dist/katex.min.css")]);
      const m = mod as unknown as { default?: KatexLike } & KatexLike;
      katex = m.default ?? m;
    })();
  }
  return loading;
}

function render(content: string, display: boolean): string | null {
  const key = (display ? "1:" : "0:") + content;
  const cached = htmlCache.get(key);
  if (cached !== undefined) return cached;
  if (!katex) return null;
  let html: string;
  try {
    html = katex.renderToString(content, { displayMode: display, throwOnError: false });
  } catch {
    html = "";
  }
  htmlCache.set(key, html);
  return html;
}

function build(state: EditorState): DecorationSet {
  const { doc, selection } = state;
  const decos: Decoration[] = [];
  let pending = false;
  doc.descendants((node, pos) => {
    if (node.type.name === "codeBlock") return false; // never treat code as math
    if (!node.isText || !node.text) return;
    if (node.marks.some((mk) => mk.type.name === "code")) return;
    for (const mm of findMath(node.text)) {
      const from = pos + mm.from;
      const to = pos + mm.to;
      // Cursor inside the span → show the raw `$…$` source for editing.
      if (selection.from <= to && selection.to >= from) continue;
      const html = render(mm.content, mm.display);
      if (html === null) {
        pending = true; // KaTeX still loading; leave raw for now
        continue;
      }
      if (html === "") continue; // render failed — leave raw
      decos.push(Decoration.inline(from, to, { class: "nv-math-src" }));
      decos.push(
        Decoration.widget(
          from,
          () => {
            const span = document.createElement("span");
            span.className = mm.display ? "nv-math nv-math-block" : "nv-math";
            span.innerHTML = html;
            return span;
          },
          { side: 1 },
        ),
      );
    }
  });
  if (pending) {
    void ensureKatex().then(() => {
      const v = pluginView;
      if (v) v.dispatch(v.state.tr.setMeta(mathKey, { rerender: true }));
    });
  }
  return DecorationSet.create(doc, decos);
}

/** Live-preview math: inline `$…$` and block `$$…$$` render via KaTeX widgets
 *  while the cursor is outside them, and fall back to raw source for editing.
 *  Decoration-only — the `$…$` Markdown is never mutated. */
export const MathExtension = Extension.create({
  name: "nvMath",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: mathKey,
        state: {
          init: (_config, state) => build(state),
          apply: (tr, old, _oldState, newState) => {
            const meta = tr.getMeta(mathKey) as { rerender?: boolean } | undefined;
            if (tr.docChanged || tr.selectionSet || meta?.rerender) return build(newState);
            return old;
          },
        },
        props: {
          decorations(state) {
            return mathKey.getState(state) as DecorationSet;
          },
        },
        view(view) {
          pluginView = view;
          return {
            destroy() {
              if (pluginView === view) pluginView = null;
            },
          };
        },
      }),
    ];
  },
});
