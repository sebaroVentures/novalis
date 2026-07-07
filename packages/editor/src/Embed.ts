// Embed / transclusion: a standalone `![[Note]]` line renders the target inline
// as a read-only embed (a note body, an image, or a "missing" chip). Like
// WikiLink/Math/Callout this is decoration-only — the `![[…]]` stays plain text
// in the document, so tiptap-markdown round-trips it untouched and there is no
// custom node for the serializer to learn. The raw source is hidden via an
// inline decoration and revealed for editing when the cursor enters it.
//
// Note bodies are rendered by an injected `renderNote(body, mount)` callback
// (the host mounts a nested read-only editor and returns an unmount fn) so this
// module never imports the editor component — avoiding a circular import and
// keeping the recursion-depth guard on the host side.

import { Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { findEmbeds } from "./embedMatches";
import { spanOverlapChanged, type Span } from "./selectionOverlap";

/** What an `![[embed]]` target resolved to, as seen by the editor. Produced by
 *  the host's `onResolve` callback (which classifies images by extension and
 *  resolves notes via IPC). A discriminated union so each branch carries only
 *  the fields it needs. */
export type EmbedResult =
  | { kind: "note"; path: string; title: string; body: string }
  | { kind: "image"; src: string }
  | { kind: "missing" };

export interface EmbedLabels {
  /** Shown while the target is being resolved. */
  loading: string;
  /** Shown when the target note does not exist (click to create + open). */
  missing: string;
  /** Shown when the note exists but the `#section` anchor doesn't. */
  sectionMissing: string;
  /** Affordance to open the embedded note. */
  openNote: string;
}

export interface EmbedOptions {
  /** Resolve a target to a renderable result. Host-owned (IPC + image classify). */
  onResolve?: (target: string) => Promise<EmbedResult>;
  /** Open (creating if absent) the embedded/ missing note. */
  onOpenNote?: (target: string) => void;
  /** Render a note body read-only into `mount`; returns an unmount cleanup. The
   *  host injects this (nested editor via createRoot) so the extension needn't
   *  import the editor. Falls back to plain text when omitted. */
  renderNote?: (body: string, mount: HTMLElement) => (() => void) | void;
  labels?: Partial<EmbedLabels>;
  /** Root CSS class on the embed widget. Defaults to `nv-embed`. */
  className?: string;
}

const embedKey = new PluginKey("nvEmbed");

const DEFAULT_LABELS: EmbedLabels = {
  loading: "Loading…",
  missing: "Note not found",
  sectionMissing: "Section not found",
  openNote: "Open note",
};

export const Embed = Extension.create<EmbedOptions>({
  name: "nvEmbed",

  addOptions() {
    return {
      onResolve: undefined,
      onOpenNote: undefined,
      renderNote: undefined,
      labels: DEFAULT_LABELS,
      className: "nv-embed",
    };
  },

  addProseMirrorPlugins() {
    const onResolve = this.options.onResolve;
    const onOpenNote = this.options.onOpenNote;
    const renderNote = this.options.renderNote;
    const labels = { ...DEFAULT_LABELS, ...this.options.labels };
    const className = this.options.className ?? "nv-embed";

    // Instance-scoped (NOT module-level): a nested embed editor mounts its own
    // copy of this plugin, and a shared cache / view handle would let nested
    // instances clobber each other's resolution + rerender. Resetting per mount
    // also means re-opening a note re-resolves its embeds (fresh content).
    const cache = new Map<string, EmbedResult>();
    const inFlight = new Set<string>();
    let pluginView: EditorView | null = null;

    const resolveAsync = (target: string) => {
      if (!onResolve || inFlight.has(target) || cache.has(target)) return;
      inFlight.add(target);
      void onResolve(target)
        .then((res) => cache.set(target, res))
        .catch(() => cache.set(target, { kind: "missing" }))
        .finally(() => {
          inFlight.delete(target);
          // Repaint once the content has arrived (mirrors Math's KaTeX-loaded
          // rerender). The empty meta transaction triggers `apply` → `build`.
          const v = pluginView;
          if (v) v.dispatch(v.state.tr.setMeta(embedKey, { rerender: true }));
        });
    };

    const openHandlers = (el: HTMLElement, target: string) => {
      // mousedown preventDefault stops the editor from moving the selection into
      // the (contentEditable=false) widget before the click fires.
      el.addEventListener("mousedown", (e) => e.preventDefault());
      el.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenNote?.(target);
      });
    };

    const makeWidget = (
      from: number,
      target: string,
      occ: number,
      result: EmbedResult | undefined,
    ): Decoration => {
      const variant = result ? result.kind : "loading";
      // Stable identity so ProseMirror reuses the DOM (and the mounted nested
      // editor) across transactions instead of rebuilding on every keystroke /
      // cursor move. `occ` disambiguates the same target appearing twice; the
      // variant flips exactly once (loading → resolved) then stays put.
      // `occ` (not an absolute position) is deliberate: it stays stable while
      // typing in blocks above the embed; the only churn is the rare case of
      // adding/removing an *earlier* same-target embed, which remounts the
      // survivors once (no leak, self-heals).
      const key = `${className}:${occ}:${variant}:${target}`;
      let cleanup: (() => void) | null = null;

      const toDOM = () => {
        const host = document.createElement("span");
        host.className = className;
        host.setAttribute("contenteditable", "false");
        host.setAttribute("data-embed-target", target);

        if (!result) {
          host.classList.add("nv-embed-loading");
          host.textContent = labels.loading;
        } else if (result.kind === "image") {
          host.classList.add("nv-embed-image");
          const img = document.createElement("img");
          img.src = result.src;
          img.alt = target;
          host.appendChild(img);
        } else if (result.kind === "note") {
          host.classList.add("nv-embed-note");
          // A `Note#Section` target shows as "Note › Section"; an empty body for
          // a sectioned target means the section heading wasn't found.
          const hashIdx = target.indexOf("#");
          const section = hashIdx >= 0 ? target.slice(hashIdx + 1).trim() : "";
          const noteTitle = result.title || (hashIdx >= 0 ? target.slice(0, hashIdx) : target);
          const header = document.createElement("div");
          header.className = "nv-embed-header";
          const titleEl = document.createElement("span");
          titleEl.className = "nv-embed-title";
          titleEl.textContent = section ? `${noteTitle} › ${section}` : noteTitle;
          const openBtn = document.createElement("button");
          openBtn.type = "button";
          openBtn.className = "nv-embed-open";
          openBtn.textContent = labels.openNote;
          openHandlers(openBtn, target);
          header.appendChild(titleEl);
          header.appendChild(openBtn);
          host.appendChild(header);
          if (section && result.body.trim() === "") {
            const miss = document.createElement("div");
            miss.className = "nv-embed-section-missing";
            miss.textContent = labels.sectionMissing;
            host.appendChild(miss);
          } else {
            const mount = document.createElement("div");
            mount.className = "nv-embed-body";
            host.appendChild(mount);
            if (renderNote) {
              const c = renderNote(result.body, mount);
              cleanup = typeof c === "function" ? c : null;
            } else {
              mount.textContent = result.body;
            }
          }
        } else {
          host.classList.add("nv-embed-missing");
          host.textContent = `${labels.missing}: ${target}`;
          openHandlers(host, target);
        }
        return host;
      };

      return Decoration.widget(from, toDOM, {
        side: -1,
        key,
        // Tear down the nested React root when the widget leaves the set (cursor
        // entered for editing, content changed, or the embed was deleted). The
        // single most important cleanup — a missed unmount leaks a React root.
        destroy: () => {
          cleanup?.();
          cleanup = null;
        },
      });
    };

    interface EmbedState {
      decos: DecorationSet;
      /** Every rendered embed span — including cursor-revealed ones — so
       *  `apply` can tell which cursor moves actually change the decorations. */
      spans: Span[];
    }

    const build = (state: EditorState): EmbedState => {
      const { doc, selection } = state;
      const decos: Decoration[] = [];
      const spans: Span[] = [];
      const occByTarget = new Map<string, number>();
      doc.descendants((node, pos) => {
        if (node.type.name === "codeBlock") return false; // never embed inside code
        if (!node.isText || !node.text) return;
        if (node.marks.some((mk) => mk.type.name === "code")) return;
        for (const em of findEmbeds(node.text)) {
          const from = pos + em.from;
          const to = pos + em.to;
          // Standalone-line guard: only render when the `![[…]]` is the *entire*
          // content of its block (Phase-1 limitation); otherwise leave it literal.
          // Exact (untrimmed) compare so a whitespace-padded line (`  ![[Note]]`)
          // also falls back to literal text rather than rendering the stray
          // padding above the block widget — matchText has no surrounding space.
          const matchText = node.text.slice(em.from, em.to);
          if (doc.resolve(from).parent.textContent !== matchText) continue;

          spans.push({ from, to });

          // Count occurrences per target for stable widget keys (computed before
          // the cursor-reveal skip so the index doesn't shift when one is being
          // edited).
          const occ = occByTarget.get(em.target) ?? 0;
          occByTarget.set(em.target, occ + 1);

          // Cursor inside the run → show the raw `![[…]]` source for editing.
          if (selection.from <= to && selection.to >= from) continue;

          const result = cache.get(em.target);
          if (!result) resolveAsync(em.target);
          decos.push(Decoration.inline(from, to, { class: "nv-embed-src" }));
          decos.push(makeWidget(from, em.target, occ, result));
        }
      });
      return { decos: DecorationSet.create(doc, decos), spans };
    };

    return [
      new Plugin({
        key: embedKey,
        state: {
          init: (_config, state) => build(state),
          apply: (tr, value: EmbedState, oldState, newState) => {
            const meta = tr.getMeta(embedKey) as { rerender?: boolean } | undefined;
            if (tr.docChanged || meta?.rerender) return build(newState);
            // Selection-only transaction: rebuild only when the cursor entered
            // or left an embed (raw-source reveal) — otherwise keep the set,
            // and with it the mounted nested editors' DOM. With no doc change
            // the mapping is empty, so mapping the set would be an identity.
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
            return (embedKey.getState(state) as EmbedState).decos;
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
