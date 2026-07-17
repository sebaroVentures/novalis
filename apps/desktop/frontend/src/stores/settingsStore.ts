// Central store for vault-synced Preferences edited in the Settings dialog.
// Owns the `taskView`, `appearance`, `editor`, `calendar`, `general`, and
// `git` blocks.
// `fileTree` is owned by vaultStore — we never write it (we re-read fresh and
// carry it over) to avoid clobbering folder colors / manual order.
//
// Model: panels patch a block → in-memory state updates immediately (responsive
// UI + live appearance) and a debounced persist writes to disk. persist() does a
// read-modify-write (re-read fresh, overwrite only our blocks) so it races
// cleanly with vaultStore.persistFileTree.

import { create } from "zustand";

import {
  api,
  type AppearancePrefs,
  type CalendarPrefs,
  type EditorPrefs,
  type GeneralPrefs,
  type GitPrefs,
  type Preferences,
  type SavedQuery,
  type TaskViewPrefs,
} from "../ipc/api";
import { applyAppearance } from "../lib/appearance";
import { useVault } from "./vaultStore";

interface SettingsState {
  prefs: Preferences | null;
  loaded: boolean;

  load: () => Promise<void>;
  setAppearance: (patch: Partial<AppearancePrefs>) => void;
  setEditor: (patch: Partial<EditorPrefs>) => void;
  setCalendar: (patch: Partial<CalendarPrefs>) => void;
  setGeneral: (patch: Partial<GeneralPrefs>) => void;
  setTaskView: (patch: Partial<TaskViewPrefs>) => void;
  setGit: (patch: Partial<GitPrefs>) => void;
  setSavedQueries: (queries: SavedQuery[]) => void;
  flush: () => Promise<void>;
  /** Immediately write any pending debounced persist (and await it), so a quit
   *  within PERSIST_DELAY doesn't drop the last settings / saved-query change.
   *  A no-op when nothing is pending. Wired into App.tsx onCloseRequested. */
  flushPending: () => Promise<void>;
}

// Mirrors the Rust-side serde defaults — the `git` block and each of its
// fields are optional on the wire (older configs lack them), so consumers
// resolve to a complete value before patching or rendering.
export function resolveGitPrefs(g: GitPrefs | undefined): Required<GitPrefs> {
  return {
    enabled: g?.enabled ?? false,
    authorName: g?.authorName ?? "Novalis",
    authorEmail: g?.authorEmail ?? "novalis@localhost",
    autoCommitSecs: g?.autoCommitSecs ?? 300,
  };
}

const PERSIST_DELAY = 400;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function persist(get: () => SettingsState): Promise<void> {
  const p = get().prefs;
  if (!p) return;
  try {
    // Re-read fresh so a concurrent fileTree write (vaultStore) isn't lost; we
    // only overwrite the blocks this store owns.
    const fresh = await api.getPreferences();
    await api.setPreferences({
      ...fresh,
      taskView: p.taskView,
      appearance: p.appearance,
      editor: p.editor,
      calendar: p.calendar,
      general: p.general,
      git: p.git ?? fresh.git,
      savedQueries: p.savedQueries ?? fresh.savedQueries,
    });
  } catch (e) {
    // A dropped write (IO error, or a saved query / setting change that never
    // reached disk) must not vanish silently — surface it on the global toast.
    useVault.getState().reportError(e);
  }
}

function schedulePersist(get: () => SettingsState): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persist(get);
  }, PERSIST_DELAY);
}

export const useSettings = create<SettingsState>((set, get) => ({
  prefs: null,
  loaded: false,

  load: async () => {
    try {
      const prefs = await api.getPreferences();
      set({ prefs, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  setAppearance: (patch) => {
    const p = get().prefs;
    if (!p) return;
    const appearance = { ...p.appearance, ...patch };
    set({ prefs: { ...p, appearance } });
    applyAppearance(appearance);
    schedulePersist(get);
  },

  setEditor: (patch) => {
    const p = get().prefs;
    if (!p) return;
    set({ prefs: { ...p, editor: { ...p.editor, ...patch } } });
    schedulePersist(get);
  },

  setCalendar: (patch) => {
    const p = get().prefs;
    if (!p) return;
    set({ prefs: { ...p, calendar: { ...p.calendar, ...patch } } });
    schedulePersist(get);
  },

  setGeneral: (patch) => {
    const p = get().prefs;
    if (!p) return;
    set({ prefs: { ...p, general: { ...p.general, ...patch } } });
    schedulePersist(get);
  },

  setTaskView: (patch) => {
    const p = get().prefs;
    if (!p) return;
    set({ prefs: { ...p, taskView: { ...p.taskView, ...patch } } });
    schedulePersist(get);
  },

  setGit: (patch) => {
    const p = get().prefs;
    if (!p) return;
    set({ prefs: { ...p, git: { ...resolveGitPrefs(p.git), ...patch } } });
    schedulePersist(get);
  },

  setSavedQueries: (queries) => {
    const p = get().prefs;
    if (!p) return;
    set({ prefs: { ...p, savedQueries: queries } });
    schedulePersist(get);
  },

  flush: async () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persist(get);
  },

  flushPending: async () => {
    if (!persistTimer) return; // nothing debounced — already on disk
    clearTimeout(persistTimer);
    persistTimer = null;
    await persist(get);
  },
}));
