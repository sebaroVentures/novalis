// Device-local workspace layout (open tabs + which is active), persisted per
// vault — mirrors sidebarPrefs. Phase 1b keeps exactly ONE pane; the model is
// already pane-shaped so splits (Phase 2) extend it without a migration.

/** One editor region. `tabs` are vault-relative note paths; `activeTab` is the
 *  one currently loaded into the live editor (or null when the pane is empty). */
export interface Pane {
  id: string;
  tabs: string[];
  activeTab: string | null;
}

export interface Workspace {
  panes: Pane[];
  focusedPaneId: string;
}

/** The single pane id used in Phase 1b (and the default focused pane). */
export const MAIN_PANE_ID = "main";

/** A fresh, empty workspace: one focused pane with no tabs. */
export function emptyWorkspace(): Workspace {
  return { panes: [{ id: MAIN_PANE_ID, tabs: [], activeTab: null }], focusedPaneId: MAIN_PANE_ID };
}

const KEY = (vaultPath: string) => `novalis:workspace:${vaultPath}`;

/** Load the persisted workspace for a vault, defensively. Phase 1b collapses
 *  whatever was stored into a single pane (forward-compatible: a Phase-2 layout
 *  is flattened to its first pane's tabs rather than lost or crashing). */
export function loadWorkspacePrefs(vaultPath: string): Workspace {
  try {
    const raw = localStorage.getItem(KEY(vaultPath));
    if (!raw) return emptyWorkspace();
    const p = JSON.parse(raw) as Partial<Workspace>;
    const firstPane = Array.isArray(p.panes) ? p.panes[0] : undefined;
    const tabs = Array.isArray(firstPane?.tabs)
      ? firstPane!.tabs.filter((x): x is string => typeof x === "string")
      : [];
    const activeTab =
      typeof firstPane?.activeTab === "string" && tabs.includes(firstPane.activeTab)
        ? firstPane.activeTab
        : (tabs[tabs.length - 1] ?? null);
    return { panes: [{ id: MAIN_PANE_ID, tabs, activeTab }], focusedPaneId: MAIN_PANE_ID };
  } catch {
    return emptyWorkspace();
  }
}

export function saveWorkspacePrefs(vaultPath: string, ws: Workspace): void {
  try {
    localStorage.setItem(KEY(vaultPath), JSON.stringify(ws));
  } catch {
    /* ignore quota / serialization errors — layout is non-critical view state */
  }
}
