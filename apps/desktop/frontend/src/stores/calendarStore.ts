import { create } from "zustand";

import { api, type CalendarEvent } from "../ipc/api";
import { useSettings } from "./settingsStore";

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** The 42-day (6-week) grid covering a month, honoring the week-start pref. */
export function monthGrid(month: Date, weekStart: "monday" | "sunday" = "monday"): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  // Days to step back to reach the first cell (the configured week start).
  const offset = weekStart === "sunday" ? first.getDay() : (first.getDay() + 6) % 7;
  start.setDate(1 - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/** The current week-start preference (defaults to Monday). */
export function currentWeekStart(): "monday" | "sunday" {
  return useSettings.getState().prefs?.calendar?.weekStart === "sunday" ? "sunday" : "monday";
}

interface CalState {
  month: Date;
  events: CalendarEvent[];
  loading: boolean;
  load: () => Promise<void>;
  setMonth: (d: Date) => void;
  prev: () => void;
  next: () => void;
  today: () => void;
}

const firstOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

export const useCalendar = create<CalState>((set, get) => ({
  month: firstOfMonth(new Date()),
  events: [],
  loading: false,

  load: async () => {
    set({ loading: true });
    const grid = monthGrid(get().month, currentWeekStart());
    const start = isoDate(grid[0]);
    const end = isoDate(grid[grid.length - 1]);
    try {
      set({ events: await api.listEvents(start, end), loading: false });
    } catch {
      set({ loading: false });
    }
  },

  setMonth: (month) => {
    set({ month: firstOfMonth(month) });
    void get().load();
  },
  prev: () => {
    const m = get().month;
    get().setMonth(new Date(m.getFullYear(), m.getMonth() - 1, 1));
  },
  next: () => {
    const m = get().month;
    get().setMonth(new Date(m.getFullYear(), m.getMonth() + 1, 1));
  },
  today: () => get().setMonth(new Date()),
}));
