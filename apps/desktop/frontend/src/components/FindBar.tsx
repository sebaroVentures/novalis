import { useEffect, useRef, useState } from "react";

import { type Editor, findInfo } from "@novalis/editor";
import { CaseSensitive, ChevronDown, ChevronUp, X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface FindBarProps {
  editor: Editor;
  onClose: () => void;
}

/** In-note find & replace bar. Drives the editor's find-plugin commands and
 *  shows the current match position. Mounted above the editor content. */
export function FindBar({ editor, onClose }: FindBarProps) {
  const { t } = useTranslation("editor");
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [info, setInfo] = useState({ total: 0, current: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the find field when the bar opens.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Push the search term to the editor whenever it changes.
  useEffect(() => {
    editor.commands.setSearch(query, caseSensitive);
  }, [editor, query, caseSensitive]);

  // Reflect match count/position from the plugin on every transaction.
  useEffect(() => {
    const update = () => setInfo(findInfo(editor));
    update();
    editor.on("transaction", update);
    return () => {
      editor.off("transaction", update);
    };
  }, [editor]);

  // Clear highlights when the bar closes.
  useEffect(() => {
    return () => {
      if (!editor.isDestroyed) editor.commands.clearSearch();
    };
  }, [editor]);

  const onFindKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) editor.commands.findPrev();
      else editor.commands.findNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      // Re-pressing Cmd+F while open just refocuses the field.
      e.preventDefault();
      inputRef.current?.select();
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-surface-2 px-5 py-1.5 text-xs">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onFindKeyDown}
        placeholder={t("find")}
        className="w-40 rounded-md border border-border bg-app px-2 py-1 text-fg outline-none focus:border-accent"
      />
      <span className="min-w-14 tabular-nums text-fg-faint">
        {query.length === 0
          ? null
          : info.total === 0
            ? t("noMatches")
            : t("findCount", { current: info.current, total: info.total })}
      </span>
      <button
        onClick={() => editor.commands.findPrev()}
        title={t("findPrev")}
        className="rounded-md p-1 text-fg-muted transition-colors hover:bg-active hover:text-fg"
      >
        <ChevronUp size={14} />
      </button>
      <button
        onClick={() => editor.commands.findNext()}
        title={t("findNext")}
        className="rounded-md p-1 text-fg-muted transition-colors hover:bg-active hover:text-fg"
      >
        <ChevronDown size={14} />
      </button>
      <button
        onClick={() => setCaseSensitive((v) => !v)}
        title={t("matchCase")}
        aria-pressed={caseSensitive}
        className={`rounded-md p-1 transition-colors hover:bg-active hover:text-fg ${
          caseSensitive ? "bg-active text-fg" : "text-fg-muted"
        }`}
      >
        <CaseSensitive size={14} />
      </button>
      <input
        value={replacement}
        onChange={(e) => setReplacement(e.target.value)}
        placeholder={t("replaceWith")}
        className="w-40 rounded-md border border-border bg-app px-2 py-1 text-fg outline-none focus:border-accent"
      />
      <button
        onClick={() => editor.commands.replaceCurrent(replacement)}
        className="rounded-md px-2 py-1 text-fg-muted transition-colors hover:bg-active hover:text-fg"
      >
        {t("replace")}
      </button>
      <button
        onClick={() => editor.commands.replaceAll(replacement)}
        className="rounded-md px-2 py-1 text-fg-muted transition-colors hover:bg-active hover:text-fg"
      >
        {t("replaceAll")}
      </button>
      <button
        onClick={onClose}
        title={t("closeFind")}
        className="ml-auto rounded-md p-1 text-fg-muted transition-colors hover:bg-active hover:text-fg"
      >
        <X size={14} />
      </button>
    </div>
  );
}
