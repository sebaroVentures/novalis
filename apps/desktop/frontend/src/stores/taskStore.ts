import { create } from "zustand";

import { displayError } from "../lib/errors";
import { api, type KanbanColumnDef, type Task } from "../ipc/api";
import { topFolderFromPath } from "../lib/taskDisplay";
import { useVault } from "./vaultStore";

export type TaskFilter = "open" | "completed" | "all";
export type TaskMode = "list" | "kanban";

/** Coarse due-date buckets for the board filter bar. */
export type DueBucket = "any" | "overdue" | "today" | "week" | "none";

/** How the Kanban board groups cards into swimlanes. View setting, not a
 *  filter — lives only in memory. */
export type BoardGroupBy = "none" | "note" | "folder" | "project";

/** Client-side narrowing applied on top of the server `filter` (open/all/…).
 *  Lives only in memory — never written to notes. */
export interface BoardFilter {
  text: string;
  priority: string | null;
  tag: string | null;
  due: DueBucket;
  /** Top-level folder of the source note, or null for any. */
  folder: string | null;
  /** `@project(slug)` of the task, or null for any. */
  project: string | null;
}

export const EMPTY_BOARD_FILTER: BoardFilter = {
  text: "",
  priority: null,
  tag: null,
  due: "any",
  folder: null,
  project: null,
};

// Monotonic token for load() (mirrors vaultStore's adoptSeq): rapid re-loads
// (filter flips, quick successive mutations) can resolve out of order, and a
// slow earlier response must not overwrite a newer one (last-call-wins).
let loadSeq = 0;

export function boardFilterActive(f: BoardFilter): boolean {
  return (
    f.text.trim() !== "" ||
    f.priority !== null ||
    f.tag !== null ||
    f.due !== "any" ||
    f.folder !== null ||
    f.project !== null
  );
}

/** Narrow the already-loaded task list by the board filter (pure). */
export function filterTasks(tasks: Task[], f: BoardFilter): Task[] {
  const q = f.text.trim().toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const weekEnd = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  return tasks.filter((t) => {
    if (q && !t.text.toLowerCase().includes(q)) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.tag && !t.tags.includes(f.tag)) return false;
    if (f.folder && topFolderFromPath(t.sourceNote) !== f.folder) return false;
    if (f.project && t.project !== f.project) return false;
    switch (f.due) {
      case "overdue":
        if (!t.dueDate || t.dueDate >= today) return false;
        break;
      case "today":
        if (t.dueDate !== today) return false;
        break;
      case "week":
        if (!t.dueDate || t.dueDate < today || t.dueDate > weekEnd) return false;
        break;
      case "none":
        if (t.dueDate) return false;
        break;
    }
    return true;
  });
}

/** Completion rollup of a task's direct children (from the parsed `parentId`). */
export function subtaskProgress(tasks: Task[], parentId: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const t of tasks) {
    if (t.parentId === parentId) {
      total += 1;
      if (t.completed) done += 1;
    }
  }
  return { done, total };
}

/** Distinct tags across the given tasks, sorted — for the tag filter dropdown. */
export function allTags(tasks: Task[]): string[] {
  const set = new Set<string>();
  for (const t of tasks) for (const tag of t.tags) set.add(tag);
  return [...set].sort();
}

/** Distinct non-empty top-level folders across the tasks' source notes, sorted —
 *  for the folder filter dropdown. Root-level notes (no folder) are omitted. */
export function topFolders(tasks: Task[]): string[] {
  const set = new Set<string>();
  for (const t of tasks) {
    const folder = topFolderFromPath(t.sourceNote);
    if (folder) set.add(folder);
  }
  return [...set].sort();
}

/** Distinct `@project` slugs across the tasks, sorted — for the project filter
 *  dropdown and the detail-modal datalist. */
export function allProjects(tasks: Task[]): string[] {
  const set = new Set<string>();
  for (const t of tasks) if (t.project) set.add(t.project);
  return [...set].sort();
}

/** Distinct `@epic` slugs across the tasks, sorted — for the epic datalist. */
export function allEpics(tasks: Task[]): string[] {
  const set = new Set<string>();
  for (const t of tasks) if (t.epic) set.add(t.epic);
  return [...set].sort();
}

/** A Kanban column with guaranteed id/title (the generated type has them
 *  optional because of serde defaults). */
export interface Column {
  id: string;
  title: string;
}

export const DEFAULT_COLUMNS: Column[] = [
  { id: "backlog", title: "Backlog" },
  { id: "todo", title: "To Do" },
  { id: "in-progress", title: "In Progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
];

/** Normalize a stored/preference mode string to a current TaskMode. The retired
 *  "agenda" mode folds into "list" (its due-date grouping now lives there). */
export function toTaskMode(mode: string | null | undefined): TaskMode | null {
  if (mode === "kanban") return "kanban";
  if (mode === "list" || mode === "agenda") return "list";
  return null;
}

function normalizeColumns(columns: KanbanColumnDef[] | Column[] | null | undefined): Column[] {
  const cols = (columns ?? [])
    .map((c) => ({ id: c.id ?? "", title: c.title ?? "" }))
    .filter((c) => c.id !== "");
  return cols.length > 0 ? cols : DEFAULT_COLUMNS;
}

interface TaskState {
  tasks: Task[];
  filter: TaskFilter;
  mode: TaskMode;
  /** True once `mode` has been seeded from the saved default (or set manually).
   *  Guards `load()` so the once-per-session default never reverts a manual
   *  switch on a later reload (filter/toggle/add all re-call `load()`). */
  modeInitialized: boolean;
  columns: Column[];
  loading: boolean;
  /** Set when the last load() failed — so an empty board renders as a failure
   *  banner, not a legitimately empty task list. Cleared on the next success. */
  error: string | null;
  /** In-memory board narrowing (text/priority/tag/due/folder). Never persisted. */
  boardFilter: BoardFilter;
  /** How the Kanban board groups cards into swimlanes. Never persisted. */
  boardGroupBy: BoardGroupBy;
  /** Session-only override of the task-creation destination, set via the
   *  NewTaskBar chip. Null = follow the `taskCreation` strategy. Never persisted
   *  (persistent policy lives in preferences). */
  pinnedNotePath: string | null;
  /** The most recent note paths picked as a task destination (create or move),
   *  most-recent first, capped at 5. Surfaced atop the note picker. Session-only. */
  recentDestinations: string[];
  /** Right-click card menu: target task id + cursor position, or null. */
  cardMenu: { taskId: string; x: number; y: number } | null;

  load: () => Promise<void>;
  setFilter: (f: TaskFilter) => void;
  setMode: (m: TaskMode) => void;
  applyDefaultMode: (m: string | null | undefined) => void;
  setColumnsFromPreferences: (columns: KanbanColumnDef[] | Column[] | null | undefined) => void;
  toggle: (id: string) => Promise<void>;
  setStatus: (id: string, status: string) => Promise<void>;
  updateField: (
    id: string,
    field: "project" | "epic" | "priority" | "due" | "start" | "remind" | "repeat",
    value: string | null,
  ) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  moveTask: (id: string, destNote: string) => Promise<void>;
  addTask: (text: string, opts?: { notePath?: string; status?: string }) => Promise<void>;
  setBoardFilter: (patch: Partial<BoardFilter>) => void;
  clearBoardFilter: () => void;
  setBoardGroupBy: (g: BoardGroupBy) => void;
  setPinnedNotePath: (path: string | null) => void;
  pushRecentDestination: (path: string) => void;
  openCardMenu: (taskId: string, x: number, y: number) => void;
  closeCardMenu: () => void;
}

export const useTasks = create<TaskState>((set, get) => ({
  tasks: [],
  filter: "open",
  mode: "list",
  modeInitialized: false,
  columns: DEFAULT_COLUMNS,
  loading: false,
  error: null,
  boardFilter: EMPTY_BOARD_FILTER,
  boardGroupBy: "none",
  pinnedNotePath: null,
  recentDestinations: [],
  cardMenu: null,

  load: async () => {
    const seq = ++loadSeq;
    set({ loading: true });
    try {
      const [tasks, prefs] = await Promise.all([
        api.listTasks(get().filter),
        api.getPreferences(),
      ]);
      if (seq !== loadSeq) return; // superseded by a newer load
      const next: Partial<TaskState> = {
        tasks,
        columns: normalizeColumns(prefs.taskView?.kanbanColumns),
        loading: false,
        error: null,
      };
      // Seed the view mode from the saved default exactly once per session. Read
      // the flag here (after the await) so a manual setMode during the in-flight
      // load is respected, and never override it on subsequent reloads.
      if (!get().modeInitialized) {
        const dm = toTaskMode(prefs.taskView?.defaultMode);
        if (dm) next.mode = dm;
        next.modeInitialized = true;
      }
      set(next);
    } catch (e) {
      if (seq === loadSeq) set({ loading: false, error: displayError(e) });
    }
  },

  setFilter: (filter) => {
    set({ filter });
    void get().load();
  },
  setMode: (mode) => set({ mode, modeInitialized: true }),
  applyDefaultMode: (mode) => {
    const next = toTaskMode(mode);
    if (next) set({ mode: next, modeInitialized: true });
  },
  setColumnsFromPreferences: (columns) => set({ columns: normalizeColumns(columns) }),

  toggle: async (id) => {
    try {
      await api.toggleTask(id);
      await get().load();
    } catch (e) {
      useVault.getState().reportError(e);
    }
  },

  setStatus: async (id, status) => {
    try {
      await api.setTaskStatus(id, status);
      await get().load();
    } catch (e) {
      useVault.getState().reportError(e);
    }
  },

  updateField: async (id, field, value) => {
    try {
      await api.updateTask(id, field, value);
      await get().load();
    } catch (e) {
      useVault.getState().reportError(e);
    }
  },

  deleteTask: async (id) => {
    try {
      await api.deleteTask(id);
      await get().load();
      get().closeCardMenu();
    } catch (e) {
      useVault.getState().reportError(e);
    }
  },

  moveTask: async (id, destNote) => {
    try {
      await api.moveTask(id, destNote);
      // The task id is derived from path+line, so it changes on move; a reload
      // rebuilds the list under the new note.
      await get().load();
      get().closeCardMenu();
    } catch (e) {
      useVault.getState().reportError(e);
    }
  },

  addTask: async (text, opts) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      await api.createTask(trimmed, { notePath: opts?.notePath, status: opts?.status });
      await get().load();
    } catch (e) {
      useVault.getState().reportError(e);
    }
  },

  setBoardFilter: (patch) => set({ boardFilter: { ...get().boardFilter, ...patch } }),
  clearBoardFilter: () => set({ boardFilter: EMPTY_BOARD_FILTER }),
  setBoardGroupBy: (boardGroupBy) => set({ boardGroupBy }),
  setPinnedNotePath: (pinnedNotePath) => set({ pinnedNotePath }),
  pushRecentDestination: (path) =>
    set({ recentDestinations: [path, ...get().recentDestinations.filter((p) => p !== path)].slice(0, 5) }),
  openCardMenu: (taskId, x, y) => set({ cardMenu: { taskId, x, y } }),
  closeCardMenu: () => set({ cardMenu: null }),
}));
