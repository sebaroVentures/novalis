import { useEffect, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import { getMarkdown } from "@novalis/editor";

import { api, type NoteTemplate } from "../ipc/api";
import { fuzzyRank } from "../lib/fuzzy";
import { type ActionId, formatChord } from "../lib/keybindings";
import { localWeekRange } from "../lib/weeklyReview";
import { useAi } from "../stores/aiStore";
import { useCanvas } from "../stores/canvasStore";
import { useKeymap } from "../stores/keymapStore";
import { usePlugins } from "../stores/pluginStore";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";
import { useVaultChat } from "../stores/vaultChatStore";
import { Modal } from "./ui/Modal";

interface Command {
  id: string;
  title: string;
  /** Right-aligned hint: a formatted shortcut, the built-in badge, or plugin id. */
  badge: string;
  run: () => void;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation(["vault", "common", "today"]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const pluginCommands = usePlugins((s) => s.commands);
  const keymap = useKeymap((s) => s.keymap);
  const inputRef = useRef<HTMLInputElement>(null);

  const openTodaysNote = () => {
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
    const path = `journal/${iso.slice(0, 4)}/${iso}.md`;
    void (async () => {
      try {
        await api.createNote(path, { content: "" });
      } catch {
        /* already exists */
      }
      await useVault.getState().refreshTree();
      useUi.getState().openNoteFrom(path, "today");
    })();
  };

  // Render a template's variables (shared backend renderer) and insert the
  // markdown at the cursor of the open note. No-op if no note/editor is active.
  const insertTemplate = (tpl: NoteTemplate) => {
    const ed = useUi.getState().activeEditor;
    if (!ed) return;
    const title = useVault.getState().activeNote?.title ?? null;
    void (async () => {
      const md = await api.renderTemplate(tpl.content, title);
      ed.chain().focus().insertContent(md).run();
    })();
  };

  // Phase 1 (no AI): compute the current local week, fetch the deterministic
  // digest, and insert its markdown at the cursor of the open note — the same
  // cursor-insert path as templates. Works with no AI provider configured.
  const insertWeeklyDigest = () => {
    const ed = useUi.getState().activeEditor;
    if (!ed) return;
    void (async () => {
      const { start, end } = localWeekRange();
      const digest = await api.reviewDigest(start, end);
      ed.chain().focus().insertContent(digest.markdown).run();
    })();
  };

  const builtin = (id: string, title: string, action: ActionId | null, run: () => void): Command => ({
    id: `builtin:${id}`,
    title,
    badge: action ? formatChord(keymap[action]) : t("cmdCore"),
    run,
  });

  const viewTitle: Record<"notes" | "today" | "tasks" | "calendar" | "graph" | "canvas", string> = {
    notes: t("common:views.notes"),
    today: t("common:views.today"),
    tasks: t("common:views.tasks"),
    calendar: t("common:views.calendar"),
    graph: t("common:views.graph"),
    canvas: t("common:views.canvas"),
  };

  const builtins: Command[] = [
    builtin("view-notes", viewTitle.notes, "view-notes", () => useUi.getState().setView("notes")),
    builtin("view-today", viewTitle.today, "view-today", () => useUi.getState().setView("today")),
    builtin("view-tasks", viewTitle.tasks, "view-tasks", () => useUi.getState().setView("tasks")),
    builtin("view-calendar", viewTitle.calendar, "view-calendar", () =>
      useUi.getState().setView("calendar"),
    ),
    builtin("view-graph", viewTitle.graph, "view-graph", () => useUi.getState().setView("graph")),
    builtin("view-canvas", viewTitle.canvas, "view-canvas", () =>
      useUi.getState().setView("canvas"),
    ),
    builtin("new-canvas", t("cmdNewCanvas"), null, () => void useCanvas.getState().createAndOpen()),
    builtin("new-note", t("cmdNewNote"), "new-note", () =>
      void useVault.getState().newNote(useVault.getState().selectedFolder ?? ""),
    ),
    builtin("today-note", t("today:openTodaysNote"), null, openTodaysNote),
    builtin("reindex", t("cmdReindex"), null, () => void api.reindexVault()),
    builtin("reveal-in-fm", t("cmdRevealInFm"), null, () => {
      const p = useVault.getState().activeNote?.path;
      if (p) void useVault.getState().revealInFileManager(p);
    }),
    // Whole-note AI action: open the task-extraction review for the active note.
    builtin("extract-tasks", t("cmdExtractTasks"), null, () => {
      const ed = useUi.getState().activeEditor;
      const note = useVault.getState().activeNote;
      if (ed && note) {
        useAi.getState().startTaskExtract({
          editor: ed,
          notePath: note.path,
          noteTitle: note.title,
          body: getMarkdown(ed),
        });
      }
    }),
    // Chat with your vault — opens the right-docked RAG panel (which surfaces
    // "no connection configured" itself when there's none).
    builtin("chat-vault", t("cmdChatVault"), null, () => useVaultChat.getState().openPanel()),
    // Phase 1 deterministic digest — no AI required.
    builtin("insert-weekly-digest", t("cmdInsertDigest"), null, insertWeeklyDigest),
    // Phase 2 AI narrative + carry-overs — opens the review card (which needs a
    // configured provider; it surfaces "no connections" itself when there's none).
    builtin("weekly-review", t("cmdWeeklyReview"), null, () => {
      const ed = useUi.getState().activeEditor;
      const note = useVault.getState().activeNote;
      if (ed && note) {
        useAi.getState().startWeeklyReview({
          editor: ed,
          notePath: note.path,
          noteTitle: note.title,
          body: getMarkdown(ed),
        });
      }
    }),
  ];

  const templateCmds: Command[] = templates.map((tpl) =>
    builtin(`insert-template:${tpl.id}`, t("cmdInsertTemplate", { name: tpl.name }), null, () =>
      insertTemplate(tpl),
    ),
  );

  const pluginCmds: Command[] = pluginCommands.map((c) => ({
    id: c.id,
    title: c.title,
    badge: c.pluginId,
    run: c.run,
  }));

  const filtered = fuzzyRank(
    [...builtins, ...templateCmds, ...pluginCmds],
    query.trim(),
    (c) => c.title,
  );

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      void api
        .listTemplates()
        .then(setTemplates)
        .catch(() => setTemplates([]));
    }
  }, [open]);

  if (!open) return null;

  const run = (c: Command) => {
    c.run();
    onClose();
  };

  // Escape is handled by the Modal shell (close, restore focus).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      const c = filtered[selected];
      if (c) run(c);
    }
  };

  return (
    <Modal
      label={t("cmdPlaceholder")}
      onClose={onClose}
      initialFocusRef={inputRef}
      overlayClassName="z-50 items-start justify-center pt-28"
      panelClassName="w-full max-w-lg overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(0);
        }}
        placeholder={t("cmdPlaceholder")}
        className="w-full bg-transparent px-4 py-3 text-fg outline-none placeholder:text-fg-faint"
        onKeyDown={onKeyDown}
      />
      <ul className="max-h-80 overflow-y-auto border-t border-border">
        {filtered.length === 0 && (
          <li className="px-4 py-3 text-sm text-fg-faint">{t("cmdEmpty")}</li>
        )}
        {filtered.map((c, i) => (
          <li key={c.id}>
            <button
              onMouseMove={() => setSelected(i)}
              onClick={() => run(c)}
              className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left ${
                i === selected ? "bg-active" : "hover:bg-hover"
              }`}
            >
              <span className="text-sm text-fg">{c.title}</span>
              <span className="text-[10px] uppercase tracking-wide text-fg-faint">{c.badge}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
