// Device-local workspace layout (panes, open tabs + which is active), persisted
// per vault — mirrors sidebarPrefs. Phase 2: a flat list of panes split along
// one axis (a binary tree is overkill for 2-4 panes); `flex` carries the
// divider-drag size ratios.

/** One editor region. `tabs` are vault-relative note paths; `activeTab` is the
 *  one currently loaded into the pane's live editor (or null when empty). */
export interface Pane {
  id: string;
  tabs: string[];
  activeTab: string | null;
  /** Relative size share along the split axis (default 1). */
  flex?: number;
}

export interface Workspace {
  panes: Pane[];
  focusedPaneId: string;
  /** Split axis once there are ≥2 panes ("row" = side by side). */
  direction: "row" | "column";
}

/** The default pane id (and the default focused pane). */
export const MAIN_PANE_ID = "main";

/** Hard cap on visible panes — each one is a live TipTap instance. */
export const MAX_PANES = 4;

/** A fresh, empty workspace: one focused pane with no tabs. */
export function emptyWorkspace(): Workspace {
  return {
    panes: [{ id: MAIN_PANE_ID, tabs: [], activeTab: null }],
    focusedPaneId: MAIN_PANE_ID,
    direction: "row",
  };
}

const KEY = (vaultPath: string) => `novalis:workspace:${vaultPath}`;

function sanitizePane(raw: unknown, taken: Set<string>): Pane | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Partial<Pane>;
  if (typeof p.id !== "string" || !p.id || taken.has(p.id)) return null;
  const tabs = Array.isArray(p.tabs)
    ? p.tabs.filter((x): x is string => typeof x === "string")
    : [];
  const activeTab =
    typeof p.activeTab === "string" && tabs.includes(p.activeTab)
      ? p.activeTab
      : (tabs[tabs.length - 1] ?? null);
  const flex = typeof p.flex === "number" && Number.isFinite(p.flex) && p.flex > 0 ? p.flex : 1;
  return { id: p.id, tabs, activeTab, flex };
}

/** Load the persisted workspace for a vault, defensively: malformed panes are
 *  dropped, empty extra panes collapse away, and the single-pane Phase-1b shape
 *  loads unchanged (it is already pane-array-shaped). */
export function loadWorkspacePrefs(vaultPath: string): Workspace {
  try {
    const raw = localStorage.getItem(KEY(vaultPath));
    if (!raw) return emptyWorkspace();
    const p = JSON.parse(raw) as Partial<Workspace>;
    const panes: Pane[] = [];
    const taken = new Set<string>();
    for (const rp of Array.isArray(p.panes) ? p.panes : []) {
      const pane = sanitizePane(rp, taken);
      if (!pane) continue;
      taken.add(pane.id);
      panes.push(pane);
      if (panes.length === MAX_PANES) break;
    }
    // An empty pane next to populated ones is dead space — keep empties only
    // when there is nothing else to show.
    const populated = panes.filter((q) => q.tabs.length > 0);
    const kept = populated.length > 0 ? populated : panes.slice(0, 1);
    if (kept.length === 0) return emptyWorkspace();
    const focusedPaneId = kept.some((q) => q.id === p.focusedPaneId)
      ? (p.focusedPaneId as string)
      : kept[0].id;
    return { panes: kept, focusedPaneId, direction: p.direction === "column" ? "column" : "row" };
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
