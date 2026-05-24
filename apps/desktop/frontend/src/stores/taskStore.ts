import { create } from "zustand";

import { api, type Task } from "../ipc/api";

export type TaskFilter = "open" | "completed" | "all";
export type TaskMode = "list" | "kanban" | "agenda";

/** A Kanban column with guaranteed id/title (the generated type has them
 *  optional because of serde defaults). */
export interface Column {
  id: string;
  title: string;
}

const DEFAULT_COLUMNS: Column[] = [
  { id: "backlog", title: "Backlog" },
  { id: "todo", title: "To Do" },
  { id: "in-progress", title: "In Progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
];

interface TaskState {
  tasks: Task[];
  filter: TaskFilter;
  mode: TaskMode;
  columns: Column[];
  loading: boolean;

  load: () => Promise<void>;
  setFilter: (f: TaskFilter) => void;
  setMode: (m: TaskMode) => void;
  toggle: (id: string) => Promise<void>;
  setStatus: (id: string, status: string) => Promise<void>;
  addTask: (text: string) => Promise<void>;
}

export const useTasks = create<TaskState>((set, get) => ({
  tasks: [],
  filter: "open",
  mode: "list",
  columns: DEFAULT_COLUMNS,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const [tasks, prefs] = await Promise.all([
        api.listTasks(get().filter),
        api.getPreferences(),
      ]);
      const cols = (prefs.taskView?.kanbanColumns ?? [])
        .map((c) => ({ id: c.id ?? "", title: c.title ?? "" }))
        .filter((c) => c.id !== "");
      set({ tasks, columns: cols.length > 0 ? cols : DEFAULT_COLUMNS, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  setFilter: (filter) => {
    set({ filter });
    void get().load();
  },
  setMode: (mode) => set({ mode }),

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

  addTask: async (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      await api.createTask(trimmed);
      await get().load();
    } catch {
      /* ignore */
    }
  },
}));
