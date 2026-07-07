// WikiLinkSuggestion: a `[[` autocomplete for wikilinks, built on
// @tiptap/suggestion. Typing `[[` opens a popover of matching note titles;
// selecting one inserts plain `[[Title]]` text (NOT a custom node) so the
// markdown round-trip stays trivial and the existing WikiLink decoration
// renders it. The popover is a minimal self-managed DOM element (no tippy/React
// dependency) attached to the editor root so it inherits the editor's theme.

import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import {
  Suggestion,
  type SuggestionKeyDownProps,
  type SuggestionMatch,
  type SuggestionProps,
  type Trigger,
} from "@tiptap/suggestion";

import { withDismissal } from "./suggestDismiss";

/** A candidate link target surfaced by the host's title search. */
export interface LinkTarget {
  title: string;
  path: string;
  /** Synthetic "create a new note named <title>" row (no existing match). */
  create?: boolean;
}

export interface WikiLinkSuggestionOptions {
  /** Title search the host wires to its index (e.g. quick search). */
  onSearch?: (query: string) => Promise<LinkTarget[]>;
  /** Label template for the synthetic "create new note" row; `{{query}}` is
   *  replaced with the typed title. Omit to disable the create row. */
  createLabel?: string;
}

const wikiSuggestKey = "wikiLinkSuggestion";

/** Match an open `[[` (no closing `]]`) ending at the cursor, capturing the
 *  partial title typed so far. Mirrors the default matcher's use of `$position`
 *  but triggers on the two-bracket sequence instead of a single char. */
function findWikiMatch({ $position }: Trigger): SuggestionMatch {
  const from = $position.start();
  const textBefore = $position.doc.textBetween(from, $position.pos, "\n", "\0");
  const m = /\[\[([^[\]\n]*)$/.exec(textBefore);
  if (!m) return null;
  return {
    range: { from: $position.pos - m[0].length, to: $position.pos },
    query: m[1],
    text: m[0],
  };
}

/** Build the suggestion lifecycle managing a small DOM popover. `onDismiss`
 *  marks the session dismissed on Escape (see withDismissal) so the Suggestion
 *  plugin genuinely exits it — not just hides the popup. */
function createRenderer(onDismiss: (range: { from: number }) => void, createLabel?: string) {
  let popup: HTMLDivElement | null = null;
  let items: LinkTarget[] = [];
  let selected = 0;
  let command: ((item: LinkTarget) => void) | null = null;

  const draw = () => {
    if (!popup) return;
    popup.innerHTML = "";
    if (items.length === 0) {
      popup.style.display = "none";
      return;
    }
    popup.style.display = "block";
    items.forEach((item, i) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `nv-suggest-item${i === selected ? " is-selected" : ""}${item.create ? " nv-suggest-create" : ""}`;
      el.textContent =
        item.create && createLabel ? createLabel.replace("{{query}}", item.title) : item.title;
      // mousedown (not click) so the editor doesn't lose selection first.
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        command?.(item);
      });
      el.addEventListener("mouseenter", () => {
        selected = i;
        draw();
      });
      popup?.appendChild(el);
    });
  };

  const place = (rect: DOMRect | null | undefined) => {
    if (!popup || !rect) return;
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.bottom + 4}px`;
  };

  return {
    onStart(props: SuggestionProps<LinkTarget, LinkTarget>) {
      items = props.items;
      selected = 0;
      command = props.command;
      popup = document.createElement("div");
      popup.className = "nv-suggest";
      const root =
        (props.editor.view.dom.closest(".nv-editor") as HTMLElement | null) ?? document.body;
      root.appendChild(popup);
      place(props.clientRect?.());
      draw();
    },
    onUpdate(props: SuggestionProps<LinkTarget, LinkTarget>) {
      items = props.items;
      command = props.command;
      if (selected >= items.length) selected = 0;
      place(props.clientRect?.());
      draw();
    },
    onKeyDown(props: SuggestionKeyDownProps): boolean {
      const { key } = props.event;
      if (key === "ArrowDown") {
        if (items.length) selected = (selected + 1) % items.length;
        draw();
        return true;
      }
      if (key === "ArrowUp") {
        if (items.length) selected = (selected - 1 + items.length) % items.length;
        draw();
        return true;
      }
      if ((key === "Enter" || key === "Tab") && items[selected]) {
        command?.(items[selected]);
        return true;
      }
      if (key === "Escape") {
        // End the session, don't just hide the popup: mark the token dismissed
        // and dispatch an (empty) transaction so the Suggestion plugin
        // re-evaluates now — it exits synchronously (onExit removes the popup)
        // and a following Enter inserts a plain newline again.
        onDismiss(props.range);
        props.view.dispatch(props.view.state.tr);
        return true;
      }
      return false;
    },
    onExit() {
      popup?.remove();
      popup = null;
      items = [];
      selected = 0;
      command = null;
    },
  };
}

export const WikiLinkSuggestion = Extension.create<WikiLinkSuggestionOptions>({
  name: "wikiLinkSuggestion",

  addOptions() {
    return { onSearch: undefined, createLabel: undefined };
  },

  addProseMirrorPlugins() {
    const onSearch = this.options.onSearch;
    const createLabel = this.options.createLabel;
    const matcher = withDismissal(findWikiMatch); // Escape ends the session
    return [
      Suggestion<LinkTarget, LinkTarget>({
        editor: this.editor,
        pluginKey: new PluginKey(wikiSuggestKey),
        char: "[",
        allowSpaces: true,
        findSuggestionMatch: matcher.findSuggestionMatch,
        items: async ({ query }) => {
          const results = onSearch ? await onSearch(query) : [];
          const q = query.trim();
          // Offer "create <q>" when something was typed and no title matches it
          // exactly (case-insensitive). The note is materialized lazily on click.
          if (createLabel && q && !results.some((r) => r.title.toLowerCase() === q.toLowerCase())) {
            return [...results, { title: q, path: "", create: true }];
          }
          return results;
        },
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [{ type: "text", text: `[[${props.title}]]` }])
            .run();
        },
        render: () => createRenderer(matcher.dismiss, createLabel),
      }),
    ];
  },
});
