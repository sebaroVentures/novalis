import { useEffect, useMemo, useRef, useState } from "react";

import { ChevronRight, FilePlus, Folder } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, type NoteSummary } from "../ipc/api";
import { fuzzyRank } from "../lib/fuzzy";
import { collectFolders, collectNotes } from "../lib/noteTree";
import { useVault } from "../stores/vaultStore";
import { Modal } from "./ui/Modal";

function ensureMd(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
}

/** A row in the picker: an existing note, or a folder to drill into. */
type Entry =
  | { kind: "note"; path: string; title: string; recent?: boolean }
  | { kind: "folder"; path: string };

/** A fuzzy note-picker modal, reusing the command-palette shell. When the query
 *  is empty it lists the recent destinations (passed in) followed by all notes;
 *  while typing it also matches folders — picking a folder drills into it so you
 *  can choose or create a note there. Offers to create a new note when the query
 *  matches nothing. Sits above the task card menu (z-[60]). `onPick` receives the
 *  chosen note's vault-relative path. */
export function NotePickerModal({
  open,
  onClose,
  onPick,
  title,
  initialQuery,
  recentPaths,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (notePath: string) => void;
  title: string;
  initialQuery?: string;
  /** Recent destination paths (most-recent first), shown atop the empty state. */
  recentPaths?: string[];
}) {
  const { t } = useTranslation("common");
  const tree = useVault((s) => s.tree);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const allNotes = useMemo(() => collectNotes(tree), [tree]);
  const allFolders = useMemo(() => collectFolders(tree), [tree]);

  // Empty query → recent destinations first, then the rest alphabetically.
  // Non-empty → fuzzy-rank notes *and* folders on title + path, so folder names
  // (e.g. "Projects/") are matchable.
  const results = useMemo<Entry[]>(() => {
    const q = query.trim();
    if (q === "") {
      const byPath = new Map(allNotes.map((n) => [n.path, n]));
      const recents = (recentPaths ?? [])
        .map((p) => byPath.get(p))
        .filter((n): n is NoteSummary => Boolean(n))
        .slice(0, 5);
      const seen = new Set(recents.map((n) => n.path));
      const rest = allNotes
        .filter((n) => !seen.has(n.path))
        .sort((a, b) => a.title.localeCompare(b.title));
      return [
        ...recents.map((n): Entry => ({ kind: "note", path: n.path, title: n.title, recent: true })),
        ...rest.map((n): Entry => ({ kind: "note", path: n.path, title: n.title })),
      ];
    }
    const combined: Entry[] = [
      ...allFolders.map((f): Entry => ({ kind: "folder", path: f.path })),
      ...allNotes.map((n): Entry => ({ kind: "note", path: n.path, title: n.title })),
    ];
    return fuzzyRank(combined, q, (e) => (e.kind === "folder" ? e.path : `${e.title} ${e.path}`));
  }, [allNotes, allFolders, recentPaths, query]);

  const trimmed = query.trim();
  const createPath = ensureMd(trimmed);
  const basename = trimmed.split("/").pop() ?? "";
  const showCreate = useMemo(
    () =>
      trimmed !== "" &&
      basename !== "" &&
      !allNotes.some(
        (n) => n.path === createPath || n.title.toLowerCase() === trimmed.toLowerCase(),
      ),
    [allNotes, trimmed, basename, createPath],
  );
  const rowCount = results.length + (showCreate ? 1 : 0);

  useEffect(() => {
    if (open) {
      setQuery(initialQuery ?? "");
      setSelected(0);
    }
  }, [open, initialQuery]);

  if (!open) return null;

  const pick = (path: string) => {
    onPick(path);
    onClose();
  };

  const drillInto = (folderPath: string) => {
    setQuery(`${folderPath}/`);
    setSelected(0);
    inputRef.current?.focus();
  };

  const createAndPick = () => {
    void (async () => {
      try {
        await api.createNote(createPath, { content: "" });
      } catch {
        /* already exists — fall through and use it */
      }
      await useVault.getState().refreshTree();
      pick(createPath);
    })();
  };

  const activate = (i: number) => {
    if (showCreate && i === results.length) {
      createAndPick();
      return;
    }
    const e = results[i];
    if (!e) return;
    if (e.kind === "folder") drillInto(e.path);
    else pick(e.path);
  };

  // Escape is handled by the Modal shell (close, restore focus).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, rowCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      activate(selected);
    }
  };

  return (
    <Modal
      label={title}
      onClose={onClose}
      initialFocusRef={inputRef}
      overlayClassName="z-[60] items-start justify-center pt-28"
      panelClassName="w-full max-w-lg overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
    >
      <div className="px-4 pt-3 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
        {title}
      </div>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(0);
        }}
        placeholder={t("notePicker.placeholder")}
        className="w-full bg-transparent px-4 py-3 text-fg outline-none placeholder:text-fg-faint"
        onKeyDown={onKeyDown}
      />
      <ul className="max-h-80 overflow-y-auto border-t border-border">
        {rowCount === 0 && (
          <li className="px-4 py-3 text-sm text-fg-faint">{t("notePicker.empty")}</li>
        )}
        {results.map((e, i) =>
          e.kind === "folder" ? (
            <li key={`f:${e.path}`}>
              <button
                onMouseMove={() => setSelected(i)}
                onClick={() => drillInto(e.path)}
                className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left ${
                  i === selected ? "bg-active" : "hover:bg-hover"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Folder size={14} className="shrink-0 text-fg-subtle" />
                  <span className="truncate text-sm text-fg">{e.path}</span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-fg-faint" />
              </button>
            </li>
          ) : (
            <li key={`n:${e.path}`}>
              <button
                onMouseMove={() => setSelected(i)}
                onClick={() => pick(e.path)}
                className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left ${
                  i === selected ? "bg-active" : "hover:bg-hover"
                }`}
              >
                <span className="flex min-w-0 flex-col items-start gap-0.5">
                  <span className="text-sm text-fg">{e.title}</span>
                  <span className="truncate text-[11px] text-fg-faint">{e.path}</span>
                </span>
                {e.recent && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-faint">
                    {t("notePicker.recent")}
                  </span>
                )}
              </button>
            </li>
          ),
        )}
        {showCreate && (
          <li>
            <button
              onMouseMove={() => setSelected(results.length)}
              onClick={createAndPick}
              className={`flex w-full items-center gap-2 px-4 py-2 text-left ${
                selected === results.length ? "bg-active" : "hover:bg-hover"
              }`}
            >
              <FilePlus size={14} className="shrink-0 text-fg-subtle" />
              <span className="text-sm text-fg">
                {t("notePicker.createNote", { name: createPath })}
              </span>
            </button>
          </li>
        )}
      </ul>
    </Modal>
  );
}
