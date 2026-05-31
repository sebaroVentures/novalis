import { create } from "zustand";

import { api, type KanbanColumnDef, type Task } from "../ipc/api";

export type TaskFilter = "open" | "completed" | "all";
export type TaskMode = "list" | "kanban" | "agenda";

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

function toTaskMode(mode: string | null | undefined): TaskMode | null {
  return mode === "list" || mode === "kanban" || mode === "agenda" ? mode : null;
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

  load: () => Promise<void>;
  setFilter: (f: TaskFilter) => void;
  setMode: (m: TaskMode) => void;
  applyDefaultMode: (m: string | null | undefined) => void;
  setColumnsFromPreferences: (columns: KanbanColumnDef[] | Column[] | null | undefined) => void;
  toggle: (id: string) => Promise<void>;
  setStatus: (id: string, status: string) => Promise<void>;
  addTask: (text: string, opts?: { notePath?: string }) => Promise<void>;
}

export const useTasks = create<TaskState>((set, get) => ({
  tasks: [],
  filter: "open",
  mode: "list",
  modeInitialized: false,
  columns: DEFAULT_COLUMNS,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const [tasks, prefs] = await Promise.all([
        api.listTasks(get().filter),
        api.getPreferences(),
      ]);
      const next: Partial<TaskState> = {
        tasks,
        columns: normalizeColumns(prefs.taskView?.kanbanColumns),
        loading: false,
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
    } catch {
      set({ loading: false });
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
    } catch {
      /* surfaced elsewhere */
    }
  },

  setStatus: async (id, status) => {
    try {
      await api.setTaskStatus(id, status);
      await get().load();
    } catch {
      /* ignore */
    }
  },

  addTask: async (text, opts) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      await api.createTask(trimmed, { notePath: opts?.notePath });
      await get().load();
    } catch {
      /* ignore */
    }
  },
}));
