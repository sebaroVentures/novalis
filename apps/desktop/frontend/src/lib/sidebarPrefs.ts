// Per-vault, per-device sidebar view-state in localStorage. This is *device*
// state (which folders are open, what's selected, recently opened) — distinct
// from the vault-synced folder colors / manual order, which live in backend
// Preferences (`.novalis/config.json`). Mirrors the per-vault key pattern in
// CloudHint.tsx (`dismissKey(vaultPath)`).

export interface SidebarPrefs {
  /** Folder paths that are collapsed (collapsed-set: new folders default open). */
  collapsed: string[];
  /** Currently selected folder (drives the New-Note target), or null. */
  selectedFolder: string | null;
  /** Recently opened note paths, most-recent-first. */
  recent: string[];
}

export const RECENT_LIMIT = 15;

// Device-local cap for the recent-notes list, overridable in Settings. Stored
// separately from per-vault sidebar state (it's a global device preference).
const RECENT_LIMIT_KEY = "novalis:device:recentLimit";

export function getRecentLimit(): number {
  try {
    const raw = localStorage.getItem(RECENT_LIMIT_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.min(50, n) : RECENT_LIMIT;
  } catch {
    return RECENT_LIMIT;
  }
}

export function setRecentLimit(n: number): void {
  try {
    localStorage.setItem(RECENT_LIMIT_KEY, String(Math.max(1, Math.min(50, Math.round(n)))));
  } catch {
    /* ignore quota errors */
  }
}

const KEY = (vaultPath: string) => `novalis:sidebar:${vaultPath}`;
const EMPTY: SidebarPrefs = { collapsed: [], selectedFolder: null, recent: [] };

export function loadSidebarPrefs(vaultPath: string): SidebarPrefs {
  try {
    const raw = localStorage.getItem(KEY(vaultPath));
    if (!raw) return { ...EMPTY };
    const p = JSON.parse(raw) as Partial<SidebarPrefs>;
    return {
      collapsed: Array.isArray(p.collapsed) ? p.collapsed.filter((x) => typeof x === "string") : [],
      selectedFolder: typeof p.selectedFolder === "string" ? p.selectedFolder : null,
      recent: Array.isArray(p.recent)
        ? p.recent.filter((x) => typeof x === "string").slice(0, getRecentLimit())
        : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveSidebarPrefs(vaultPath: string, prefs: SidebarPrefs): void {
  try {
    localStorage.setItem(
      KEY(vaultPath),
      JSON.stringify({ ...prefs, recent: prefs.recent.slice(0, getRecentLimit()) }),
    );
  } catch {
    /* ignore quota / serialization errors — view state is non-critical */
  }
}
