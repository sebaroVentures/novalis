// A minimal, self-managed popover for @tiptap/suggestion-driven menus (slash
// commands, #tag autocomplete). Mirrors the inline renderer in
// WikiLinkSuggestion but generic over the item type, so the two newer
// suggestion extensions share one implementation. Attached to `.nv-editor` so it
// inherits the editor theme; styled by the `.nv-suggest*` rules in editor.css.

import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";

export interface SuggestRendererOptions<T> {
  /** Visible text for an item. */
  getLabel: (item: T) => string;
  /** Extra class(es) for an item's button (e.g. to flag a "create" row). */
  getClass?: (item: T) => string | undefined;
  /** Escape handler: mark the session dismissed (see withDismissal) so the
   *  Suggestion plugin genuinely exits it — not just hides the popup. */
  onDismiss: (range: { from: number }) => void;
}

/** Build the suggestion lifecycle managing a small DOM popover, generic over the
 *  item type. Returns the `{ onStart, onUpdate, onKeyDown, onExit }` object
 *  `@tiptap/suggestion`'s `render` expects. */
export function createSuggestRenderer<T>({
  getLabel,
  getClass,
  onDismiss,
}: SuggestRendererOptions<T>) {
  let popup: HTMLDivElement | null = null;
  let items: T[] = [];
  let selected = 0;
  let command: ((item: T) => void) | null = null;

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
      const extra = getClass?.(item);
      el.className = `nv-suggest-item${i === selected ? " is-selected" : ""}${extra ? ` ${extra}` : ""}`;
      el.textContent = getLabel(item);
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
    onStart(props: SuggestionProps<T, T>) {
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
    onUpdate(props: SuggestionProps<T, T>) {
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
