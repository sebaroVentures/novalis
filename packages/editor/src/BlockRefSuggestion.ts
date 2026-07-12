// BlockRefSuggestion: a `((` autocomplete for block references, built on
// @tiptap/suggestion (same shape as WikiLinkSuggestion). Typing `((` opens a
// popover of tagged blocks matching the query; selecting one inserts plain
// `((^id))` text (NOT a custom node) so the markdown round-trip stays trivial
// and the BlockRef decoration renders it. The popover is a minimal self-managed
// DOM element attached to the editor root so it inherits the editor's theme.

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

/** A candidate block surfaced by the host's block search. */
export interface BlockCandidate {
  /** Stable block id (without the `^` sigil); inserted as `((^id))`. */
  id: string;
  /** The block's note title, shown as context in the popover. */
  noteTitle: string;
  /** The block's text (marker stripped). */
  text: string;
}

export interface BlockRefSuggestionOptions {
  /** Block search the host wires to its index (block_index text search). */
  onSearch?: (query: string) => Promise<BlockCandidate[]>;
}

const blockSuggestKey = "blockRefSuggestion";

/** Match an open `((` (no closing `))`) ending at the cursor, capturing the
 *  partial query. Mirrors WikiLinkSuggestion's two-char trigger. */
function findBlockMatch({ $position }: Trigger): SuggestionMatch {
  const from = $position.start();
  const textBefore = $position.doc.textBetween(from, $position.pos, "\n", "\0");
  const m = /\(\(([^()\n]*)$/.exec(textBefore);
  if (!m) return null;
  return {
    range: { from: $position.pos - m[0].length, to: $position.pos },
    query: m[1],
    text: m[0],
  };
}

function createRenderer(onDismiss: (range: { from: number }) => void) {
  let popup: HTMLDivElement | null = null;
  let items: BlockCandidate[] = [];
  let selected = 0;
  let command: ((item: BlockCandidate) => void) | null = null;

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
      el.className = `nv-suggest-item${i === selected ? " is-selected" : ""}`;
      const text = document.createElement("span");
      text.className = "nv-suggest-block-text";
      text.textContent = item.text;
      const note = document.createElement("span");
      note.className = "nv-suggest-block-note";
      note.textContent = item.noteTitle;
      el.appendChild(text);
      el.appendChild(note);
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
    onStart(props: SuggestionProps<BlockCandidate, BlockCandidate>) {
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
    onUpdate(props: SuggestionProps<BlockCandidate, BlockCandidate>) {
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

export const BlockRefSuggestion = Extension.create<BlockRefSuggestionOptions>({
  name: "blockRefSuggestion",

  addOptions() {
    return { onSearch: undefined };
  },

  addProseMirrorPlugins() {
    const onSearch = this.options.onSearch;
    const matcher = withDismissal(findBlockMatch); // Escape ends the session
    return [
      Suggestion<BlockCandidate, BlockCandidate>({
        editor: this.editor,
        pluginKey: new PluginKey(blockSuggestKey),
        char: "(",
        allowSpaces: true,
        findSuggestionMatch: matcher.findSuggestionMatch,
        items: async ({ query }) => (onSearch ? await onSearch(query) : []),
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(range, [{ type: "text", text: `((^${props.id}))` }])
            .run();
        },
        render: () => createRenderer(matcher.dismiss),
      }),
    ];
  },
});
