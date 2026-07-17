import { create } from "zustand";

import { displayError } from "../lib/errors";
import { api, type CalendarEvent } from "../ipc/api";
import { useSettings } from "./settingsStore";

export type CalMode = "month" | "week" | "day";

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/** The 42-day (6-week) grid covering a month, honoring the week-start pref. */
export function monthGrid(month: Date, weekStart: "monday" | "sunday" = "monday"): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  // Days to step back to reach the first cell (the configured week start).
  const offset = weekStart === "sunday" ? first.getDay() : (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/** The 7-day grid for the week containing `anchor`, honoring the week-start pref. */
export function weekGrid(anchor: Date, weekStart: "monday" | "sunday" = "monday"): Date[] {
  const offset = weekStart === "sunday" ? anchor.getDay() : (anchor.getDay() + 6) % 7;
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - offset);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/** The current week-start preference (defaults to Monday). */
export function currentWeekStart(): "monday" | "sunday" {
  return useSettings.getState().prefs?.calendar?.weekStart === "sunday" ? "sunday" : "monday";
}

/** The visible day grid for a calendar mode + anchor date. */
export function gridFor(mode: CalMode, anchor: Date, weekStart: "monday" | "sunday"): Date[] {
  if (mode === "month") return monthGrid(anchor, weekStart);
  if (mode === "week") return weekGrid(anchor, weekStart);
  return [anchor];
}

interface CalState {
  mode: CalMode;
  /** Any date within the visible period (month/week/day). */
  anchor: Date;
  events: CalendarEvent[];
  loading: boolean;
  /** Set when the last load() failed — so an empty grid renders as a failure
   *  banner, not a legitimately event-free period. Cleared on the next success. */
  error: string | null;
  load: () => Promise<void>;
  setMode: (m: CalMode) => void;
  prev: () => void;
  next: () => void;
  today: () => void;
  /** Drop the previous vault's events on a vault switch (refetched on next view). */
  reset: () => void;
}

/** Shift the anchor by one period in the given direction. */
function step(mode: CalMode, anchor: Date, dir: number): Date {
  if (mode === "month") return new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
  const days = mode === "week" ? 7 : 1;
  return new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + dir * days);
}

// Monotonic token for load() (mirrors vaultStore's adoptSeq): rapid prev/next
// steps fire overlapping fetches, and a slow earlier period's response must
// not overwrite a newer one (last-call-wins).
let loadSeq = 0;

export const useCalendar = create<CalState>((set, get) => ({
  mode: "month",
  anchor: new Date(),
  events: [],
  loading: false,
  error: null,

  load: async () => {
    const seq = ++loadSeq;
    set({ loading: true });
    const grid = gridFor(get().mode, get().anchor, currentWeekStart());
    const start = isoDate(grid[0]);
    const end = isoDate(grid[grid.length - 1]);
    try {
      const events = await api.listEvents(start, end);
      if (seq !== loadSeq) return; // superseded by a newer load
      set({ events, loading: false, error: null });
    } catch (e) {
      if (seq === loadSeq) set({ loading: false, error: displayError(e) });
    }
  },

  setMode: (mode) => {
    set({ mode });
    void get().load();
  },
  prev: () => {
    set({ anchor: step(get().mode, get().anchor, -1) });
    void get().load();
  },
  next: () => {
    set({ anchor: step(get().mode, get().anchor, 1) });
    void get().load();
  },
  today: () => {
    set({ anchor: new Date() });
    void get().load();
  },
  reset: () => {
    loadSeq++; // drop any in-flight load from the previous vault
    set({ events: [], anchor: new Date(), loading: false, error: null });
  },
}));
