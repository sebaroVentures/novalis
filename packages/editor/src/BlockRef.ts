// BlockRef: renders `((^id))` block references and dims the trailing ` ^id`
// block-ID markers. Like WikiLink/Embed/Math this is decoration-only — the
// `((^id))` and ` ^id` stay plain text in the document, so tiptap-markdown
// round-trips them untouched and there is no custom node for the serializer to
// learn. A reference's raw source is hidden via an inline decoration and
// revealed for editing when the cursor enters it (mirroring Embed).
//
// A reference resolves via an injected `onResolve(id)` callback (host-owned,
// IPC → the block index) to the target block's note + text, shown as an inline
// chip. A dangling id (its block was deleted) renders as a "missing" chip —
// references never break the way heading-text anchors do, because the id is
// content-independent.

import { Extension, type Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { findBlockId, findBlockRefs, newBlockId } from "./blockRefMatches";
import { spanOverlapChanged, type Span } from "./selectionOverlap";

/** Tag the block the cursor is in with a stable ` ^id` marker (if it has none)
 *  and return the id — the "make this block referenceable" primitive. The host
 *  wires it to a "Copy block reference" affordance: it gets back the id and
 *  copies `((^id))`. Idempotent: a block that already carries a marker keeps it
 *  (the same id, so existing references stay valid). Returns null for a block
 *  that can't be tagged (empty selection block, code block). The insertion is a
 *  round-trip-safe base36 marker — no schema change, no custom node. */
export function assignBlockId(editor: Editor): string | null {
  const { state } = editor;
  const { $from } = state.selection;
  const parent = $from.parent;
  if (!parent.isTextblock || parent.type.name === "codeBlock") return null;
  const text = parent.textContent;
  if (!text.trim()) return null;
  const existing = findBlockId(text);
  if (existing) return existing.id;
  const id = newBlockId();
  // Append ` ^id` at the end of the block's text content.
  editor.view.dispatch(state.tr.insertText(` ^${id}`, $from.end()));
  return id;
}

/** What a `((^id))` reference resolved to, as seen by the editor. Produced by
 *  the host's `onResolve` callback (IPC → the block index). */
export type BlockRefResult =
  | { kind: "block"; notePath: string; noteTitle: string; text: string }
  | { kind: "missing" };

export interface BlockRefLabels {
  /** Shown in the chip while the reference is being resolved. */
  loading: string;
  /** Shown when the referenced block no longer exists (dangling id). */
  missing: string;
}

export interface BlockRefOptions {
  /** Resolve an id to a block. Host-owned (IPC). Omitted → chips stay loading. */
  onResolve?: (id: string) => Promise<BlockRefResult>;
  /** Open the note a reference points at (click on a resolved chip). */
  onOpen?: (notePath: string) => void;
  labels?: Partial<BlockRefLabels>;
  /** Root CSS class on the reference chip. Defaults to `nv-blockref`. */
  className?: string;
}

const blockRefKey = new PluginKey("nvBlockRef");

const DEFAULT_LABELS: BlockRefLabels = {
  loading: "…",
  missing: "Block not found",
};

export const BlockRef = Extension.create<BlockRefOptions>({
  name: "nvBlockRef",

  addOptions() {
    return {
      onResolve: undefined,
      onOpen: undefined,
      labels: DEFAULT_LABELS,
      className: "nv-blockref",
    };
  },

  addProseMirrorPlugins() {
    const onResolve = this.options.onResolve;
    const onOpen = this.options.onOpen;
    const labels = { ...DEFAULT_LABELS, ...this.options.labels };
    const className = this.options.className ?? "nv-blockref";

    // Instance-scoped (NOT module-level): each editor mount gets its own cache,
    // so re-opening a note re-resolves its references (fresh content) and nested
    // editors can't clobber each other. Mirrors Embed.
    const cache = new Map<string, BlockRefResult>();
    const inFlight = new Set<string>();
    let pluginView: EditorView | null = null;

    const resolveAsync = (id: string) => {
      if (!onResolve || inFlight.has(id) || cache.has(id)) return;
      inFlight.add(id);
      void onResolve(id)
        .then((res) => cache.set(id, res))
        .catch(() => cache.set(id, { kind: "missing" }))
        .finally(() => {
          inFlight.delete(id);
          const v = pluginView;
          if (v) v.dispatch(v.state.tr.setMeta(blockRefKey, { rerender: true }));
        });
    };

    const makeChip = (
      from: number,
      id: string,
      occ: number,
      result: BlockRefResult | undefined,
    ): Decoration => {
      const variant = result ? result.kind : "loading";
      // Stable identity so ProseMirror reuses the DOM across transactions; `occ`
      // disambiguates the same id appearing twice, `variant` flips once
      // (loading → resolved) then stays put. Same scheme as Embed's widget key.
      const key = `${className}:${occ}:${variant}:${id}`;

      const toDOM = () => {
        const chip = document.createElement("span");
        chip.className = className;
        chip.setAttribute("contenteditable", "false");
        chip.setAttribute("data-block-id", id);

        if (!result) {
          chip.classList.add("nv-blockref-loading");
          chip.textContent = labels.loading;
          return chip;
        }
        if (result.kind === "missing") {
          chip.classList.add("nv-blockref-missing");
          chip.textContent = labels.missing;
          return chip;
        }
        // Resolved: "Note › block text". Click opens the source note.
        chip.classList.add("nv-blockref-resolved");
        const titleEl = document.createElement("span");
        titleEl.className = "nv-blockref-note";
        titleEl.textContent = result.noteTitle;
        const textEl = document.createElement("span");
        textEl.className = "nv-blockref-text";
        textEl.textContent = result.text;
        chip.appendChild(titleEl);
        chip.appendChild(textEl);
        chip.addEventListener("mousedown", (e) => e.preventDefault());
        chip.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpen?.(result.notePath);
        });
        return chip;
      };

      return Decoration.widget(from, toDOM, { side: -1, key });
    };

    interface BlockRefState {
      decos: DecorationSet;
      /** Every reference span, so `apply` can tell which cursor moves change
       *  the decorations (raw-source reveal). Marker spans are static so they
       *  don't need to participate. */
      spans: Span[];
    }

    const build = (state: EditorState): BlockRefState => {
      const { doc, selection } = state;
      const decos: Decoration[] = [];
      const spans: Span[] = [];
      const occById = new Map<string, number>();

      doc.descendants((node, pos) => {
        if (node.type.name === "codeBlock") return false; // never inside code
        if (!node.isText || !node.text) return;
        if (node.marks.some((mk) => mk.type.name === "code")) return;
        const text = node.text;

        // `((^id))` references → hidden source + chip widget.
        for (const ref of findBlockRefs(text)) {
          const from = pos + ref.from;
          const to = pos + ref.to;
          spans.push({ from, to });
          const occ = occById.get(ref.id) ?? 0;
          occById.set(ref.id, occ + 1);
          // Cursor inside the run → show the raw `((^id))` source for editing.
          if (selection.from <= to && selection.to >= from) continue;
          const result = cache.get(ref.id);
          if (!result) resolveAsync(ref.id);
          decos.push(Decoration.inline(from, to, { class: "nv-blockref-src" }));
          decos.push(makeChip(from, ref.id, occ, result));
        }

        // Trailing ` ^id` marker → dimmed (always visible, still editable). No
        // hide/reveal: the marker is the anchor the user may want to delete.
        const marker = findBlockId(text);
        if (marker) {
          decos.push(
            Decoration.inline(pos + marker.from, pos + marker.to, {
              class: "nv-block-anchor",
              "data-block-id": marker.id,
            }),
          );
        }
      });

      return { decos: DecorationSet.create(doc, decos), spans };
    };

    return [
      new Plugin({
        key: blockRefKey,
        state: {
          init: (_config, state) => build(state),
          apply: (tr, value: BlockRefState, oldState, newState) => {
            const meta = tr.getMeta(blockRefKey) as { rerender?: boolean } | undefined;
            if (tr.docChanged || meta?.rerender) return build(newState);
            if (
              tr.selectionSet &&
              spanOverlapChanged(value.spans, oldState.selection, newState.selection)
            ) {
              return build(newState);
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            return (blockRefKey.getState(state) as BlockRefState).decos;
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
