// WikiLink: a TipTap extension that decorates `[[Title]]` patterns inside
// text nodes as clickable spans. We use ProseMirror decorations (not a custom
// node) so the underlying document is plain text — markdown round-trip stays
// trivial and there is no schema change for tiptap-markdown to learn.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** `[[Title]]` / `[[Title#Heading]]` / `[[Title|alias]]` — anything but
 *  brackets/newlines between the double brackets. Exported so MarkdownText's
 *  serializer protects exactly the spans this extension decorates (the two
 *  must never disagree). Global regex: reset `lastIndex` before each scan. */
export const WIKI_LINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

export interface WikiLinkOptions {
  /** Called when the user clicks a wikilink. The host resolves it. */
  onClick?: (title: string) => void;
  /** Called when the pointer enters a wikilink (host shows a preview). */
  onHover?: (title: string, rect: DOMRect) => void;
  /** Called when the pointer leaves a wikilink. */
  onHoverEnd?: () => void;
  /** CSS class on the decoration span. Defaults to `nv-wikilink`. */
  className?: string;
}

const wikiLinkKey = new PluginKey("wikiLink");

function buildDecorations(doc: { descendants: Function }, className: string) {
  const decorations: Decoration[] = [];
  doc.descendants((node: any, pos: number) => {
    if (!node.isText) return;
    const text: string = node.text ?? "";
    WIKI_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKI_LINK_RE.exec(text)) !== null) {
      const start = pos + m.index;
      const end = start + m[0].length;
      const title = m[1].trim();
      if (!title) continue;
      // Skip the inner `[[…]]` of an `![[embed]]`; the Embed extension owns it.
      // `text[-1]` (match at node start) is undefined, so this is safe there.
      if (text[m.index - 1] === "!") continue;
      decorations.push(
        Decoration.inline(start, end, {
          class: className,
          "data-wiki-title": title,
        }),
      );
      // Tag the `[[` and `]]` runs separately so reading mode can hide just the
      // brackets (leaving the title text) via CSS. No effect outside reading mode.
      decorations.push(Decoration.inline(start, start + 2, { class: "nv-wikilink-bracket" }));
      decorations.push(Decoration.inline(end - 2, end, { class: "nv-wikilink-bracket" }));
    }
  });
  return DecorationSet.create(doc as any, decorations);
}

export const WikiLink = Extension.create<WikiLinkOptions>({
  name: "wikiLink",

  addOptions() {
    return {
      onClick: undefined,
      className: "nv-wikilink",
    };
  },

  addProseMirrorPlugins() {
    const className = this.options.className ?? "nv-wikilink";
    const onClick = this.options.onClick;
    const onHover = this.options.onHover;
    const onHoverEnd = this.options.onHoverEnd;

    const wikiLinkAt = (target: EventTarget | null): HTMLElement | null =>
      (target as HTMLElement | null)?.closest?.(`.${className}`) as HTMLElement | null;

    return [
      new Plugin({
        key: wikiLinkKey,
        state: {
          init: (_, { doc }) => buildDecorations(doc, className),
          apply: (tr, old) =>
            tr.docChanged ? buildDecorations(tr.doc, className) : old,
        },
        props: {
          decorations(state) {
            return this.getState(state);
          },
          handleClick(_view, _pos, event) {
            const el = wikiLinkAt(event.target);
            if (!el) return false;
            const title = el.getAttribute("data-wiki-title");
            if (!title || !onClick) return false;
            // Cmd/Ctrl-click navigates; plain click also navigates (matches
            // Obsidian). Modifier-click could be reserved for "open in pane"
            // later — not differentiated yet.
            event.preventDefault();
            onClick(title);
            return true;
          },
          handleDOMEvents: {
            mouseover(_view, event) {
              if (!onHover) return false;
              const el = wikiLinkAt(event.target);
              const title = el?.getAttribute("data-wiki-title");
              if (el && title) onHover(title, el.getBoundingClientRect());
              return false;
            },
            mouseout(_view, event) {
              if (!onHoverEnd) return false;
              const el = wikiLinkAt(event.target);
              if (!el) return false;
              // Ignore moves that stay within the same wikilink span.
              const to = event.relatedTarget as Node | null;
              if (to && el.contains(to)) return false;
              onHoverEnd();
              return false;
            },
          },
        },
      }),
    ];
  },
});
