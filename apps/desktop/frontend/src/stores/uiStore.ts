import { create } from "zustand";

import type { Editor } from "@novalis/editor";

import type { MainView } from "../components/Sidebar";
import {
  emptyWorkspace,
  loadWorkspacePrefs,
  saveWorkspacePrefs,
  type Pane,
  type Workspace,
} from "../lib/workspacePrefs";
import { useVault } from "./vaultStore";

interface UiState {
  /** The top-level view being shown (notes / tasks / calendar). */
  view: MainView;
  /** Where to return to when the user drilled into a note from elsewhere
   *  (e.g. a Kanban card). null = no pending "Back" affordance. */
  returnView: MainView | null;
  /** The TipTap editor of the open note (or null). Shared so palette actions
   *  like "Insert template" can write at the cursor without prop-drilling. */
  activeEditor: Editor | null;
  /** Editor tabs/panes (device-local, per vault). Phase 1b: exactly one pane. */
  workspace: Workspace;

  /** Switch the top-level view. A deliberate switch clears any pending "Back"
   *  target — the user chose where to be. */
  setView: (view: MainView) => void;
  /** Register/clear the open note's editor instance. */
  setActiveEditor: (editor: Editor | null) => void;
  /** Open a note and jump to the Notes view, remembering where we came from so
   *  the editor can offer a "Back" button. */
  openNoteFrom: (path: string, from: MainView) => void;
  /** Return to the remembered view (if any) and clear the Back affordance. */
  goBack: () => void;

  // ── Workspace (tabs) ──────────────────────────────────────────────────────
  /** Open `path` in the focused pane (foreground) and show the Notes view.
   *  `background` adds a tab without switching to it (⌘/middle-click); `from`
   *  records a cross-view "Back" target. Delegates the actual load to
   *  `vaultStore.openNote` (which flushes the outgoing note first). */
  openInWorkspace: (path: string, opts?: { background?: boolean; from?: MainView }) => void;
  /** Make `path` the focused pane's active tab and load it. */
  setActiveTab: (path: string) => void;
  /** Mark `path` the focused pane's active tab (adding it if absent) WITHOUT
   *  loading it — for callers that already opened the note (e.g. back/forward,
   *  which await `openNote` themselves to keep history correct). */
  activateTab: (path: string) => void;
  /** Close `path`'s tab in the focused pane, focusing a neighbor (or emptying). */
  closeTab: (path: string) => void;
  /** Focus a pane (trivial in 1b; the seam splits build on). */
  focusPane: (id: string) => void;
  /** Replace the workspace with the persisted layout for `vaultPath` and load
   *  its active tab. Called on vault activation/switch. */
  loadWorkspace: (vaultPath: string) => void;
  /** Reset to an empty workspace in memory WITHOUT persisting (so a vault swap
   *  doesn't clobber the incoming vault's saved layout before it's loaded). */
  resetWorkspace: () => void;
  /** Is `path` open as a tab in any pane? */
  isPathOpen: (path: string) => boolean;
  /** Rewrite/close tab paths after a rename/move/delete: `map` returns the new
   *  path for a tab, or null to close it. Re-syncs the live editor to the
   *  focused pane's (possibly new) active tab. */
  reconcileTabs: (map: (path: string) => string | null) => void;
}

/** The focused pane (falls back to the first pane defensively). */
function focusedPane(ws: Workspace): Pane {
  return ws.panes.find((p) => p.id === ws.focusedPaneId) ?? ws.panes[0];
}

function replacePane(ws: Workspace, id: string, fn: (p: Pane) => Pane): Workspace {
  return { ...ws, panes: ws.panes.map((p) => (p.id === id ? fn(p) : p)) };
}

function persist(ws: Workspace): void {
  const vp = useVault.getState().vaultPath;
  if (vp) saveWorkspacePrefs(vp, ws);
}

export const useUi = create<UiState>((set, get) => ({
  view: "notes",
  returnView: null,
  activeEditor: null,
  workspace: emptyWorkspace(),

  setView: (view) => set({ view, returnView: null }),

  setActiveEditor: (editor) => set({ activeEditor: editor }),

  openNoteFrom: (path, from) => get().openInWorkspace(path, { from }),

  // Following links within the note view goes through openInWorkspace, so the
  // Back target survives a reading session and one click still returns home.
  goBack: () => set({ view: get().returnView ?? "notes", returnView: null }),

  openInWorkspace: (path, opts) => {
    const ws = get().workspace;
    const pane = focusedPane(ws);
    const background = opts?.background ?? false;
    const tabs = pane.tabs.includes(path) ? pane.tabs : [...pane.tabs, path];
    const next = replacePane(ws, pane.id, (p) => ({
      ...p,
      tabs,
      activeTab: background ? p.activeTab : path,
    }));
    set({
      view: "notes",
      ...(opts?.from !== undefined ? { returnView: opts.from } : {}),
      workspace: next,
    });
    persist(next);
    // Background opens stay inert descriptors; only a foreground open loads the
    // live editor (openNote flushes the outgoing note's pending autosave first).
    if (!background) void useVault.getState().openNote(path);
  },

  setActiveTab: (path) => {
    const ws = get().workspace;
    const pane = focusedPane(ws);
    if (!pane.tabs.includes(path)) return;
    const next = replacePane(ws, pane.id, (p) => ({ ...p, activeTab: path }));
    set({ view: "notes", workspace: next });
    persist(next);
    void useVault.getState().openNote(path);
  },

  activateTab: (path) => {
    const ws = get().workspace;
    const pane = focusedPane(ws);
    const tabs = pane.tabs.includes(path) ? pane.tabs : [...pane.tabs, path];
    const next = replacePane(ws, pane.id, (p) => ({ ...p, tabs, activeTab: path }));
    set({ view: "notes", workspace: next });
    persist(next);
  },

  closeTab: async (path) => {
    if (!get().isPathOpen(path)) return;
    // If closing the live (focused, active) note, drain its pending autosave
    // FIRST — reconcileTabs may empty the pane, and clearActive() does not
    // flush, so otherwise the last debounce-window edits are lost.
    if (focusedPane(get().workspace).activeTab === path) await useVault.getState().flushActive();
    // Drop the closed note's per-path save state, then reconcile (which focuses
    // a neighbor or empties the pane and re-syncs the live editor).
    useVault.getState().dropSaveState(path);
    get().reconcileTabs((p) => (p === path ? null : p));
  },

  focusPane: (id) => {
    if (!get().workspace.panes.some((p) => p.id === id)) return;
    set({ workspace: { ...get().workspace, focusedPaneId: id } });
  },

  loadWorkspace: (vaultPath) => {
    const ws = loadWorkspacePrefs(vaultPath);
    set({ workspace: ws });
    const active = focusedPane(ws).activeTab;
    if (active) void useVault.getState().openNote(active);
  },

  resetWorkspace: () => set({ workspace: emptyWorkspace() }),

  isPathOpen: (path) => get().workspace.panes.some((p) => p.tabs.includes(path)),

  reconcileTabs: (map) => {
    const ws = get().workspace;
    const vault = useVault.getState();
    const panes = ws.panes.map((pane) => {
      const tabs: string[] = [];
      for (const t of pane.tabs) {
        const m = map(t);
        if (m && !tabs.includes(m)) tabs.push(m);
      }
      let activeTab = pane.activeTab ? map(pane.activeTab) : null;
      if (!activeTab || !tabs.includes(activeTab)) {
        // Active tab closed/removed: focus the nearest surviving neighbor by
        // ORIGINAL order — first survivor right of its old slot, else nearest to
        // the left, else any survivor. (Indexing the rebuilt array by the old
        // index is wrong when tabs left of active were also removed, e.g. a
        // folder delete that closes several at once.)
        const oldIdx = pane.activeTab ? pane.tabs.indexOf(pane.activeTab) : -1;
        const survives = (t: string | undefined): string | null => {
          const m = t != null ? map(t) : null;
          return m && tabs.includes(m) ? m : null;
        };
        let found: string | null = null;
        for (let i = oldIdx + 1; i < pane.tabs.length && !found; i++) found = survives(pane.tabs[i]);
        for (let i = oldIdx - 1; i >= 0 && !found; i--) found = survives(pane.tabs[i]);
        activeTab = found ?? tabs[tabs.length - 1] ?? null;
      }
      // Re-sync the live editor to the focused pane's resolved active tab. Also
      // reload when the LOADED note's path is stale — a move/rename rewrites
      // vault.activePath to activeTab, but activeNote still holds the old path,
      // so without this the editor sits on the cache-evicted old note.
      if (pane.id === ws.focusedPaneId) {
        if (activeTab && (vault.activePath !== activeTab || vault.activeNote?.path !== activeTab)) {
          void vault.openNote(activeTab);
        } else if (!activeTab && vault.activePath !== null) {
          vault.clearActive();
        }
      }
      return { ...pane, tabs, activeTab };
    });
    const next = { ...ws, panes };
    set({ workspace: next });
    persist(next);
    // Keep back/forward history consistent with the same rewrite, so navigation
    // can never target a renamed/moved/deleted path (or resurrect a ghost tab).
    vault.reconcileHistory(map);
  },
}));
