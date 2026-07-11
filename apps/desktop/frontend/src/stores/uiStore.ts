import { create } from "zustand";

import type { Editor } from "@novalis/editor";

import type { MainView } from "../components/Sidebar";
import { loadOnboardingDone, saveOnboardingDone } from "../lib/uiPrefs";
import {
  emptyWorkspace,
  loadWorkspacePrefs,
  MAX_PANES,
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
  /** Editor panes + tabs (device-local, per vault). 1–MAX_PANES panes split
   *  along `workspace.direction`. */
  workspace: Workspace;
  /** Whether first-run onboarding has been dismissed (persisted per device).
   *  Seeded from localStorage so a returning user never sees it again. */
  onboardingDone: boolean;

  /** Switch the top-level view. A deliberate switch clears any pending "Back"
   *  target — the user chose where to be. */
  setView: (view: MainView) => void;
  /** Mark first-run onboarding dismissed (also persists it for this device). */
  dismissOnboarding: () => void;
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
  /** Make `path` the active tab of `paneId` (default: the focused pane),
   *  focusing that pane and loading the note. */
  setActiveTab: (path: string, paneId?: string) => void;
  /** Mark `path` the focused pane's active tab (adding it if absent) WITHOUT
   *  loading it — for callers that already opened the note (e.g. back/forward,
   *  which await `openNote` themselves to keep history correct). */
  activateTab: (path: string) => void;
  /** Close `path`'s tab in `paneId` (default: the focused pane; falls back to
   *  whichever pane has it). Closing a pane's last tab closes the pane when
   *  others remain. */
  closeTab: (path: string, paneId?: string) => Promise<void>;
  /** Focus a pane and sync the live note to its active tab. */
  focusPane: (id: string) => void;
  /** Split `paneId` along `direction`, duplicating its active tab into the new
   *  pane (which takes focus). Flushes first so the duplicate mounts current
   *  content; no-op on an empty pane. The first split fixes the workspace axis. */
  splitPane: (paneId: string, direction: "row" | "column") => Promise<void>;
  /** Close a whole pane (flushes its editor first); its tabs are discarded. */
  closePane: (paneId: string) => Promise<void>;
  /** Move focus to the previous/next pane in layout order (wrapping). */
  movePaneFocus: (dir: -1 | 1) => void;
  /** Move `path`'s tab from one pane to another (it becomes the target's
   *  active tab and the target takes focus). */
  moveTabToPane: (path: string, fromPaneId: string, toPaneId: string) => Promise<void>;
  /** Update pane flex ratios (divider drag); persists when `persistNow`. */
  resizePanes: (flexById: Record<string, number>, persistNow?: boolean) => void;
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

/** A pane id that collides with no existing pane (ids persist per vault). */
function newPaneId(ws: Workspace): string {
  let id: string;
  do {
    id = `p${Math.random().toString(36).slice(2, 8)}`;
  } while (ws.panes.some((p) => p.id === id));
  return id;
}

/** Every open tab path across all panes (the keep-set for state pruning). */
function allOpenTabs(ws: Workspace): Set<string> {
  return new Set(ws.panes.flatMap((p) => p.tabs));
}

/** Point the live note (vaultStore.activePath/activeNote) at the focused
 *  pane's active tab after a workspace change. adoptFocusedNote ALWAYS flushes
 *  (even when the path is unchanged — two panes on one note must converge
 *  before the newly focused one is typed in) and records no history/recents:
 *  focusing a pane is not a navigation. */
function syncFocusedContent(ws: Workspace): void {
  void useVault.getState().adoptFocusedNote(focusedPane(ws).activeTab);
}

/** Remove `path` from a pane's tabs; if it was the active tab, focus the
 *  nearest surviving neighbor (right of its old slot, else left). */
function withoutTab(pane: Pane, path: string): Pane {
  const tabs = pane.tabs.filter((t) => t !== path);
  let activeTab = pane.activeTab;
  if (activeTab === path) {
    const i = pane.tabs.indexOf(path);
    // `tabs` keeps the original order minus one entry, so the old right
    // neighbor now sits at index i and the left one at i-1.
    activeTab = tabs[i] ?? tabs[i - 1] ?? null;
  }
  return { ...pane, tabs, activeTab };
}

export const useUi = create<UiState>((set, get) => ({
  view: "notes",
  returnView: null,
  activeEditor: null,
  workspace: emptyWorkspace(),
  onboardingDone: loadOnboardingDone(),

  setView: (view) => set({ view, returnView: null }),

  dismissOnboarding: () => {
    saveOnboardingDone(true);
    set({ onboardingDone: true });
  },

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

  setActiveTab: (path, paneId) => {
    const ws = get().workspace;
    const pane = ws.panes.find((p) => p.id === (paneId ?? ws.focusedPaneId));
    if (!pane || !pane.tabs.includes(path)) return;
    // Activating a tab focuses its pane: the clicked note becomes the live one.
    const next = {
      ...replacePane(ws, pane.id, (p) => ({ ...p, activeTab: path })),
      focusedPaneId: pane.id,
    };
    set({ view: "notes", workspace: next });
    persist(next);
    void useVault.getState().openNote(path);
  },

  activateTab: (path) => {
    const ws = get().workspace;
    // If the note is already VISIBLE in some pane, focus that pane instead of
    // duplicating it as a new tab in the focused one (back/forward across a
    // pane-focus boundary would otherwise copy tabs between panes).
    const owner = ws.panes.find((p) => p.activeTab === path);
    if (owner) {
      const next = { ...ws, focusedPaneId: owner.id };
      set({ view: "notes", workspace: next });
      persist(next);
      return;
    }
    const pane = focusedPane(ws);
    const tabs = pane.tabs.includes(path) ? pane.tabs : [...pane.tabs, path];
    const next = replacePane(ws, pane.id, (p) => ({ ...p, tabs, activeTab: path }));
    set({ view: "notes", workspace: next });
    persist(next);
  },

  closeTab: async (path, paneId) => {
    const ws = get().workspace;
    // Resolve the pane: explicit id, else the focused pane, else (for callers
    // like the sidebar that only know the path) whichever pane has the tab.
    const target =
      ws.panes.find((p) => p.id === (paneId ?? ws.focusedPaneId) && p.tabs.includes(path)) ??
      ws.panes.find((p) => p.tabs.includes(path));
    if (!target) return;
    // If closing a pane's VISIBLE note, drain its pending autosave FIRST — the
    // editor unmounts on the workspace change, and unmount does not flush. If
    // that flush FAILED, bail: unmounting would destroy the only copy of the
    // edit (it is retained on the editor for retry).
    if (target.activeTab === path) {
      await useVault.getState().flushActive();
      if (useVault.getState().surfaceSaveError(path)) return;
    }
    // Re-read after the await; bail if the workspace changed underneath.
    const cur = get().workspace;
    const pane = cur.panes.find((p) => p.id === target.id);
    if (!pane || !pane.tabs.includes(path)) return;
    const closed = withoutTab(pane, path);
    let panes: Pane[];
    if (closed.tabs.length === 0 && cur.panes.length > 1) {
      // Last tab of a pane: the pane itself closes (a lone pane stays, empty).
      panes = cur.panes.filter((p) => p.id !== pane.id);
    } else {
      panes = cur.panes.map((p) => (p.id === pane.id ? closed : p));
    }
    let focusedPaneId = cur.focusedPaneId;
    if (!panes.some((p) => p.id === focusedPaneId)) {
      const oldIdx = cur.panes.findIndex((p) => p.id === pane.id);
      focusedPaneId = panes[Math.min(oldIdx, panes.length - 1)].id;
    }
    const next = { ...cur, panes, focusedPaneId };
    set({ workspace: next });
    persist(next);
    // Drop open-note/save state for paths no longer open anywhere (a path open
    // in ANOTHER pane keeps its state), then re-sync the live note.
    useVault.getState().pruneNoteState(allOpenTabs(next));
    syncFocusedContent(next);
  },

  focusPane: (id) => {
    const ws = get().workspace;
    if (ws.focusedPaneId === id || !ws.panes.some((p) => p.id === id)) return;
    const next = { ...ws, focusedPaneId: id };
    set({ workspace: next });
    persist(next);
    syncFocusedContent(next);
  },

  splitPane: async (paneId, direction) => {
    if (get().workspace.panes.length >= MAX_PANES) return;
    if (!get().workspace.panes.find((p) => p.id === paneId)?.activeTab) return; // nothing to split
    // Flush BEFORE duplicating: the new pane mounts from openNotes, which only
    // reflects COMPLETED saves — without this it would fork the document at
    // the last save, missing the debounce window's edits.
    await useVault.getState().flushActive();
    const ws = get().workspace;
    if (ws.panes.length >= MAX_PANES) return;
    const idx = ws.panes.findIndex((p) => p.id === paneId);
    if (idx === -1) return;
    const src = ws.panes[idx];
    if (!src.activeTab) return;
    if (useVault.getState().surfaceSaveError(src.activeTab)) return;
    // The new pane duplicates the source's visible note (same-note-in-two-panes
    // is the point of a split) and takes focus.
    const pane: Pane = {
      id: newPaneId(ws),
      tabs: [src.activeTab],
      activeTab: src.activeTab,
      flex: src.flex ?? 1,
    };
    const panes = [...ws.panes.slice(0, idx + 1), pane, ...ws.panes.slice(idx + 1)];
    const next: Workspace = {
      panes,
      focusedPaneId: pane.id,
      // The first split decides the axis; later splits join it.
      direction: ws.panes.length === 1 ? direction : ws.direction,
    };
    set({ workspace: next });
    persist(next);
    syncFocusedContent(next);
  },

  closePane: async (paneId) => {
    if (get().workspace.panes.length < 2) return;
    if (!get().workspace.panes.some((p) => p.id === paneId)) return;
    // Drain every editor before one unmounts (unmount does not flush).
    await useVault.getState().flushActive();
    const cur = get().workspace;
    const idx = cur.panes.findIndex((p) => p.id === paneId);
    if (idx === -1 || cur.panes.length < 2) return;
    // Bail if the closing pane's visible note failed to save (the editor still
    // holds the only copy; removing the pane would destroy it).
    const visible = cur.panes[idx].activeTab;
    if (visible && useVault.getState().surfaceSaveError(visible)) return;
    const panes = cur.panes.filter((p) => p.id !== paneId);
    const focusedPaneId =
      cur.focusedPaneId === paneId
        ? panes[Math.min(idx, panes.length - 1)].id
        : cur.focusedPaneId;
    const next = { ...cur, panes, focusedPaneId };
    set({ workspace: next });
    persist(next);
    useVault.getState().pruneNoteState(allOpenTabs(next));
    syncFocusedContent(next);
  },

  movePaneFocus: (dir) => {
    const ws = get().workspace;
    if (ws.panes.length < 2) return;
    const idx = ws.panes.findIndex((p) => p.id === ws.focusedPaneId);
    const target = ws.panes[(idx + dir + ws.panes.length) % ws.panes.length];
    get().focusPane(target.id);
  },

  moveTabToPane: async (path, fromPaneId, toPaneId) => {
    const ws = get().workspace;
    const from = ws.panes.find((p) => p.id === fromPaneId);
    const to = ws.panes.find((p) => p.id === toPaneId);
    if (!from || !to || fromPaneId === toPaneId || !from.tabs.includes(path)) return;
    // Both the source pane's visible note (if it's the moved tab) AND the
    // target pane's current visible note lose their editor — flush everything,
    // and bail if either failed to save.
    await useVault.getState().flushActive();
    const cur = get().workspace;
    if (
      !cur.panes.some((p) => p.id === fromPaneId && p.tabs.includes(path)) ||
      !cur.panes.some((p) => p.id === toPaneId)
    ) {
      return;
    }
    for (const v of [
      cur.panes.find((p) => p.id === fromPaneId)?.activeTab,
      cur.panes.find((p) => p.id === toPaneId)?.activeTab,
    ]) {
      if (v && useVault.getState().surfaceSaveError(v)) return;
    }
    let panes = cur.panes.map((p) => {
      if (p.id === fromPaneId) return withoutTab(p, path);
      if (p.id === toPaneId) {
        return {
          ...p,
          tabs: p.tabs.includes(path) ? p.tabs : [...p.tabs, path],
          activeTab: path,
        };
      }
      return p;
    });
    const emptied = panes.find((p) => p.id === fromPaneId);
    if (emptied && emptied.tabs.length === 0 && panes.length > 1) {
      panes = panes.filter((p) => p.id !== fromPaneId);
    }
    const next = { ...cur, panes, focusedPaneId: toPaneId };
    set({ workspace: next });
    persist(next);
    syncFocusedContent(next);
  },

  resizePanes: (flexById, persistNow = true) => {
    const ws = get().workspace;
    const next = {
      ...ws,
      panes: ws.panes.map((p) => (flexById[p.id] != null ? { ...p, flex: flexById[p.id] } : p)),
    };
    set({ workspace: next });
    if (persistNow) persist(next);
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
    let panes = ws.panes.map((pane) => {
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
      return { ...pane, tabs, activeTab };
    });
    // Panes emptied by the rewrite close; when EVERY pane emptied, collapse to
    // a single empty pane (matching loadWorkspacePrefs) instead of leaving
    // multiple dead panes with nothing to close them by.
    const populated = panes.filter((p) => p.tabs.length > 0);
    if (populated.length > 0) {
      if (populated.length < panes.length) panes = populated;
    } else if (panes.length > 1) {
      panes = [panes.find((p) => p.id === ws.focusedPaneId) ?? panes[0]];
    }
    let focusedPaneId = ws.focusedPaneId;
    if (!panes.some((p) => p.id === focusedPaneId)) {
      const oldIdx = ws.panes.findIndex((p) => p.id === ws.focusedPaneId);
      focusedPaneId = (panes[Math.min(Math.max(oldIdx, 0), panes.length - 1)] ?? panes[0]).id;
    }
    const next = { ...ws, panes, focusedPaneId };
    set({ workspace: next });
    persist(next);
    // Drop open-note/save state for closed paths, then re-sync the live note.
    // (A renamed visible note self-heals: its pane remounts on the new path and
    // EditorPane's load effect fetches it.)
    vault.pruneNoteState(allOpenTabs(next));
    syncFocusedContent(next);
    // Keep back/forward history consistent with the same rewrite, so navigation
    // can never target a renamed/moved/deleted path (or resurrect a ghost tab).
    vault.reconcileHistory(map);
  },
}));
