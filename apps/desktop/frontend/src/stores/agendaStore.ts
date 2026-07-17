import { create } from "zustand";

import { displayError } from "../lib/errors";
import { api, type AgendaItem } from "../ipc/api";

/** Local-date ISO (YYYY-MM-DD) — never UTC, so "today" matches the user's day. */
export function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Shift an ISO date by whole days, staying in local time. */
export function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDay(new Date(y, m - 1, d + delta));
}

// Monotonic token for load() (mirrors vaultStore's adoptSeq): rapid day steps
// fire overlapping fetches, and a slow earlier day's response must not
// overwrite a newer one (last-call-wins).
let loadSeq = 0;

interface AgendaState {
  /** ISO date of the focused day. */
  focus: string;
  /** Events + tasks placed on the focus day (from get_agenda). */
  items: AgendaItem[];
  /** Open tasks dated before today — only populated when focus === today. */
  overdue: AgendaItem[];
  loading: boolean;
  /** Set when the last load() failed — so the empty arrays render as a failure
   *  banner, not a legitimately free day. Cleared on the next successful load. */
  error: string | null;
  load: (focus: string) => Promise<void>;
  /** Drop the previous vault's agenda on a vault switch (refetched on next view). */
  reset: () => void;
}

export const useAgenda = create<AgendaState>((set) => ({
  focus: isoDay(new Date()),
  items: [],
  overdue: [],
  loading: false,
  error: null,
  load: async (focus) => {
    const seq = ++loadSeq;
    set({ loading: true, focus });
    const today = isoDay(new Date());
    try {
      const items = await api.getAgenda(focus, focus);
      let overdue: AgendaItem[] = [];
      if (focus === today) {
        // Open tasks whose effective date is before today (events ignored).
        const past = await api.getAgenda("0001-01-01", addDays(focus, -1));
        overdue = past.filter((i) => i.kind === "task");
      }
      if (seq !== loadSeq) return; // superseded by a newer load
      set({ items, overdue, loading: false, error: null });
    } catch (e) {
      if (seq === loadSeq) set({ items: [], overdue: [], loading: false, error: displayError(e) });
    }
  },
  reset: () => {
    loadSeq++; // drop any in-flight load from the previous vault
    set({ items: [], overdue: [], focus: isoDay(new Date()), loading: false, error: null });
  },
}));
