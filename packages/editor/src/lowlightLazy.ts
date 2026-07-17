import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { createLowlight } from "lowlight";

// Empty highlight.js registry created once at module scope. Unlike
// `createLowlight(common)`, this ships ZERO language grammars in the eager
// bundle — the ~37 highlight.js grammars (`common`, ~167 kB minified) are not
// referenced statically, so they land in a lazy chunk instead of the main one.
// CodeBlockLowlight reads this instance live (it holds the reference and calls
// `.highlight()` / `.listLanguages()` on every re-decoration), so grammars
// registered later take effect immediately. Until any grammar is registered,
// `highlight()` isn't reached (see below) and every code block renders as a
// plain `<pre><code>` — no crash.
export const lowlight = createLowlight();

let loaded = false;
let loading: Promise<void> | null = null;

/** Whether the grammar set has finished registering. */
export function highlightGrammarsLoaded(): boolean {
  return loaded;
}

// Lazily register highlight.js's `common` grammar set the first time a note
// actually contains a code block. Registering the identical set that
// `createLowlight(common)` used to bundle eagerly keeps highlighting
// byte-for-byte what it was — including alias resolution (```js, ```sh, ```yml)
// and autodetection of unlabelled fences (the tiptap plugin falls back to
// `highlightAuto` over every registered language). The only change is timing:
// the grammars arrive asynchronously, so a code block briefly renders plain
// before it upgrades. Idempotent and shared across editor instances.
export function ensureHighlightGrammars(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) {
    loading = import("lowlight").then(({ common }) => {
      lowlight.register(common);
      loaded = true;
    });
  }
  return loading;
}

const lazyHighlightKey = new PluginKey("nvLazyHighlight");

/** Does the document contain at least one code block? */
function docHasCodeBlock(doc: PMNode): boolean {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (node.type.name === "codeBlock") {
      found = true;
      return false;
    }
    return undefined;
  });
  return found;
}

// CodeBlockLowlight's decoration plugin only re-runs `getDecorations` on a
// transaction that changes the document (a pure meta transaction is ignored).
// So once the grammars arrive we nudge it with a no-op `setNodeMarkup` on the
// first code block, re-setting its identical attrs: that produces a step whose
// range encapsulates the node, which is exactly the condition the plugin
// re-decorates on. `preventUpdate` stops TipTap emitting `update`, so this
// repaint doesn't arm the host's serialize/dirty tracking; `addToHistory:false`
// keeps it out of undo. The markdown is unchanged (attrs identical), so nothing
// is rewritten on disk.
function forceRehighlight(view: EditorView): void {
  const { doc } = view.state;
  let target = -1;
  doc.descendants((node, pos) => {
    if (target !== -1) return false;
    if (node.type.name === "codeBlock") {
      target = pos;
      return false;
    }
    return undefined;
  });
  if (target === -1) return;
  const node = doc.nodeAt(target);
  if (!node) return;
  const tr = view.state.tr.setNodeMarkup(target, undefined, node.attrs);
  tr.setMeta("preventUpdate", true);
  tr.setMeta("addToHistory", false);
  view.dispatch(tr);
}

/** Watches the document and lazy-loads the highlight.js grammars the first time
 *  a code block appears, then forces the code-block decorations to repaint.
 *  Instance-scoped state (mirrors Math.ts): split panes / nested embeds each get
 *  their own trigger, and a deferred repaint can't fire on a destroyed view. */
export const LazyHighlight = Extension.create({
  name: "nvLazyHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: lazyHighlightKey,
        view(view) {
          // If another pane already loaded the grammars, this editor's
          // decorations were built against them at init — no repaint needed.
          let triggered = highlightGrammarsLoaded();
          let destroyed = false;
          const maybeLoad = () => {
            if (triggered || destroyed) return;
            if (!docHasCodeBlock(view.state.doc)) return;
            triggered = true;
            void ensureHighlightGrammars().then(() => {
              if (!destroyed) forceRehighlight(view);
            });
          };
          maybeLoad(); // initial content may already contain a code block
          return {
            update: () => maybeLoad(),
            destroy: () => {
              destroyed = true;
            },
          };
        },
      }),
    ];
  },
});
