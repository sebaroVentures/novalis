import { create } from "zustand";

import { api, type GitConflict, type GitResolution } from "../ipc/api";
import { displayError } from "../lib/errors";
import i18n from "../lib/i18n";
import { useVault } from "./vaultStore";

// Git merge-conflict resolution (sync P3a). A SIBLING of conflictStore (the
// OneDrive conflict-copy flow): this one resolves the in-memory 3-way merge
// that a sync cycle reported as `Conflicted`. Stateless end to end — the
// backend re-derives the merge on every load, so closing the modal (or
// crashing) loses nothing; the next sync reports Conflicted again.

/** The user's per-file decision; `manual` carries the edit buffer. */
export type MergeChoice =
  | { kind: "ours" }
  | { kind: "theirs" }
  | { kind: "manual"; content: string };

/** The wire format `git_finalize_merge` expects for one choice. */
function toResolution(path: string, choice: MergeChoice): GitResolution {
  return {
    path,
    resolution: choice.kind === "manual" ? { manual: { content: choice.content } } : choice.kind,
  };
}

// Monotonic token for load() (mirrors calendarStore's loadSeq): a slow older
// load must not overwrite the list a newer one already set.
let loadSeq = 0;

interface GitConflictState {
  open: boolean;
  loading: boolean;
  conflicts: GitConflict[];
  /** Chosen resolution per conflicted path; finalize needs one for every path. */
  choices: Map<string, MergeChoice>;
  finalizing: boolean;
  /** Already-localized (or backend-diagnostic) message for the modal. */
  error: string | null;

  /** Open the resolver and (re)load the conflict list — called when a sync
   *  returns `Conflicted` and by the panel's "resolve" button. */
  openResolver: () => void;
  close: () => void;
  load: () => Promise<void>;
  choose: (path: string, choice: MergeChoice) => void;
  finalize: () => Promise<void>;
}

export const useGitConflicts = create<GitConflictState>((set, get) => ({
  open: false,
  loading: false,
  conflicts: [],
  choices: new Map<string, MergeChoice>(),
  finalizing: false,
  error: null,

  openResolver: () => {
    set({ open: true });
    void get().load();
  },

  close: () => set({ open: false }),

  load: async () => {
    const seq = ++loadSeq;
    set({ loading: true, error: null });
    try {
      const conflicts = await api.gitMergeConflicts();
      if (seq !== loadSeq) return; // superseded by a newer load
      set({ conflicts, choices: new Map(), loading: false });
    } catch (e) {
      if (seq !== loadSeq) return;
      set({ conflicts: [], choices: new Map(), loading: false, error: displayError(e) });
    }
  },

  choose: (path, choice) => {
    const choices = new Map(get().choices);
    choices.set(path, choice);
    set({ choices });
  },

  finalize: async () => {
    const { conflicts, choices, finalizing } = get();
    if (finalizing || conflicts.length === 0) return;
    const resolutions: GitResolution[] = [];
    for (const c of conflicts) {
      const choice = choices.get(c.path);
      if (!choice) return; // not every file resolved — the button is disabled anyway
      resolutions.push(toResolution(c.path, choice));
    }
    set({ finalizing: true, error: null });
    try {
      // CRITICAL: drain every pane's pending autosave first — finalizing
      // checks out the merged tree over the worktree, and an unflushed edit
      // would be silently overwritten. If any pane's save FAILED, its only
      // copy lives in that editor: abort loudly instead of merging over it.
      await useVault.getState().flushActive();
      const failed = [...useVault.getState().saveStates.entries()].find(([, s]) => s === "error");
      if (failed) {
        set({
          finalizing: false,
          error: i18n.t("settings:sync.merge.unsavedError", { path: failed[0] }),
        });
        return;
      }
      await api.gitFinalizeMerge(resolutions);
      // Done: the checkout wrote the merged files; the watcher reindexes them
      // and open notes reload via the external-change path (they are clean —
      // the flush above just saved them).
      set({ open: false, finalizing: false, conflicts: [], choices: new Map() });
    } catch (e) {
      // Finalize failures (push rejection, remote moved, network) keep the
      // modal open; the message says whether to retry or re-open.
      set({ finalizing: false, error: displayError(e) });
    }
  },
}));
