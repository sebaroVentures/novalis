import { create } from "zustand";

import { api, NovalisError, type FolderNode, type Note } from "../ipc/api";
import { displayError } from "../lib/errors";
import i18n from "../lib/i18n";
import {
  getRecentLimit,
  loadSidebarPrefs,
  saveSidebarPrefs,
} from "../lib/sidebarPrefs";
import { findFolder, orderedItems, type SortBy } from "../lib/treeOrder";

// In-memory note cache + in-flight de-dup. Kept outside the store so reads/
// prefetches don't trigger re-renders; only `activeNote` drives the editor.
// Reading a OneDrive "online-only" note hydrates it over the network (~1s), so
// caching + prefetch-on-hover is what makes opening feel instant.
const noteCache = new Map<string, Note>();
const inflight = new Map<string, Promise<Note>>();

/** Fetch a note once: concurrent callers for the same path share one request,
 *  and the result is cached. */
function fetchNote(path: string): Promise<Note> {
  const pending = inflight.get(path);
  if (pending) return pending;
  const p = api
    .getNote(path)
    .then((note) => {
      noteCache.set(path, note);
      inflight.delete(path);
      return note;
    })
    .catch((e) => {
      inflight.delete(path);
      throw e;
    });
  inflight.set(path, p);
  return p;
}

// ── Path helpers (vault-relative, forward-slashed) ──────────────────────────
const parentOf = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
};
const basename = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
};
/** Rewrite `path`'s `from` prefix to `to` (used when a move renames paths). */
const prefixRewrite = (path: string, from: string, to: string): string => {
  if (path === from) return to;
  if (path.startsWith(from + "/")) return to + path.slice(from.length);
  return path;
};
/** Ancestor folder paths of a note/folder path, root-first (excludes self). */
const ancestorsOf = (path: string): string[] => {
  const parts = path.split("/");
  parts.pop();
  const res: string[] = [];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    res.push(acc);
  }
  return res;
};

function collectPaths(node: FolderNode, folders: Set<string>): void {
  for (const c of node.children) {
    folders.add(c.path);
    collectPaths(c, folders);
  }
}

/** Migrate path-keyed prefs (colors + manual order) after a move `from`→`to`. */
function migratePrefsForMove(
  from: string,
  to: string,
  colors: Record<string, string>,
  order: Record<string, string[]>,
): { colors: Record<string, string>; order: Record<string, string[]> } {
  const newColors: Record<string, string> = {};
  for (const [k, v] of Object.entries(colors)) newColors[prefixRewrite(k, from, to)] = v;

  const newOrder: Record<string, string[]> = {};
  for (const [k, arr] of Object.entries(order)) {
    newOrder[prefixRewrite(k, from, to)] = arr.map((el) => prefixRewrite(el, from, to));
  }
  const oldParent = parentOf(from);
  const newParent = parentOf(to);
  if (oldParent !== newParent && newOrder[oldParent]) {
    // The blanket value-rewrite turned `from`→`to` inside the old parent's
    // array, but `to` belongs under its new parent now. Drop the stray entry; a
    // reorder drop re-places it, otherwise it sorts alphabetically.
    newOrder[oldParent] = newOrder[oldParent].filter((el) => el !== to);
    if (newOrder[oldParent].length === 0) delete newOrder[oldParent];
  }
  return { colors: newColors, order: newOrder };
}

// ── DnD payloads ────────────────────────────────────────────────────────────
export type DragItem = { kind: "note" | "folder"; path: string };
export type DropTarget =
  | { type: "into"; folder: string }
  | { type: "reorder"; folder: string; beforePath: string | null };

/** Resolve the folder a new note should be created in. */
export function newNoteFolder(s: {
  selectedFolder: string | null;
  activePath: string | null;
}): string {
  if (s.selectedFolder != null) return s.selectedFolder;
  if (s.activePath) return parentOf(s.activePath);
  return "";
}

interface VaultState {
  vaultPath: string | null;
  tree: FolderNode | null;
  activePath: string | null;
  activeNote: Note | null;
  loading: boolean;
  error: string | null;

  // Sidebar view-state (device-local).
  collapsed: Set<string>;
  selectedFolder: string | null;
  recent: string[];
  // Folder appearance / order (vault-synced via Preferences).
  folderColors: Record<string, string>;
  itemOrder: Record<string, string[]>;
  sortBy: SortBy;
  sortDir: "asc" | "desc";

  /** Sync UI state with whatever vault the backend currently has open. */
  sync: () => Promise<void>;
  pickAndOpen: () => Promise<void>;
  openVault: (path: string) => Promise<void>;
  refreshTree: () => Promise<void>;
  openNote: (path: string) => Promise<void>;
  /** Warm the cache (and OneDrive hydration) for a note, e.g. on hover. */
  prefetchNote: (path: string) => void;
  /** Drop a cached note (e.g. on external change/delete) so it re-reads. */
  invalidateNote: (path: string) => void;
  newNote: (folder: string, templateId?: string) => Promise<void>;
  deleteActive: () => Promise<void>;
  saveNote: (path: string, content: string) => Promise<void>;
  clearError: () => void;

  // Sidebar actions.
  loadSidebarState: () => Promise<void>;
  selectFolder: (path: string | null) => void;
  toggleCollapsed: (path: string) => void;
  collapseAll: () => void;
  expandAll: () => void;
  revealPath: (path: string) => void;
  setFolderColor: (path: string, color: string | null) => void;
  setSortMode: (sortBy: SortBy, sortDir?: "asc" | "desc") => void;
  createFolder: (parent: string | null, name: string) => Promise<void>;
  renameItem: (path: string, kind: "note" | "folder", newName: string) => Promise<void>;
  deleteFolder: (path: string) => Promise<void>;
  duplicateNote: (path: string) => Promise<void>;
  togglePin: (path: string, pinned: boolean) => Promise<void>;
  moveItem: (item: DragItem, target: DropTarget) => Promise<void>;
}

/** Persist device-local sidebar state to localStorage for the current vault. */
function persistSidebar(get: () => VaultState): void {
  const s = get();
  if (!s.vaultPath) return;
  saveSidebarPrefs(s.vaultPath, {
    collapsed: [...s.collapsed],
    selectedFolder: s.selectedFolder,
    recent: s.recent,
  });
}

/** Persist vault-synced file-tree prefs (colors/order/sort) via Preferences.
 *  Read-modify-write so it never clobbers `taskView` (see SettingsModal). */
async function persistFileTree(get: () => VaultState): Promise<void> {
  const s = get();
  try {
    const cur = await api.getPreferences();
    await api.setPreferences({
      ...cur,
      fileTree: {
        ...cur.fileTree,
        sortBy: s.sortBy,
        sortDir: s.sortDir,
        folderColors: s.folderColors,
        itemOrder: s.itemOrder,
      },
    });
  } catch {
    /* noVault / IO — in-memory state still drives the UI until next load */
  }
}

export const useVault = create<VaultState>((set, get) => ({
  vaultPath: null,
  tree: null,
  activePath: null,
  activeNote: null,
  loading: true,
  error: null,

  collapsed: new Set<string>(),
  selectedFolder: null,
  recent: [],
  folderColors: {},
  itemOrder: {},
  sortBy: "name",
  sortDir: "asc",

  sync: async () => {
    try {
      const vaultPath = await api.currentVault();
      set({ vaultPath, loading: false });
      if (vaultPath) {
        await get().loadSidebarState();
        await get().refreshTree();
      }
    } catch (e) {
      set({ error: displayError(e), loading: false });
    }
  },

  pickAndOpen: async () => {
    const path = await api.pickVaultFolder();
    if (path) await get().openVault(path);
  },

  openVault: async (path) => {
    set({ loading: true, error: null });
    try {
      await api.openVault(path);
      noteCache.clear();
      inflight.clear();
      set({
        vaultPath: path,
        loading: false,
        activePath: null,
        activeNote: null,
        collapsed: new Set<string>(),
        selectedFolder: null,
        recent: [],
        folderColors: {},
        itemOrder: {},
      });
      await get().loadSidebarState();
      await get().refreshTree();
    } catch (e) {
      set({ error: displayError(e), loading: false });
    }
  },

  loadSidebarState: async () => {
    const vp = get().vaultPath;
    if (!vp) return;
    const sp = loadSidebarPrefs(vp);
    set({
      collapsed: new Set(sp.collapsed),
      selectedFolder: sp.selectedFolder,
      recent: sp.recent,
    });
    try {
      const prefs = await api.getPreferences();
      const ft = prefs.fileTree;
      set({
        folderColors: ft?.folderColors ?? {},
        itemOrder: ft?.itemOrder ?? {},
        sortBy: (ft?.sortBy as SortBy) ?? "name",
        sortDir: (ft?.sortDir as "asc" | "desc") ?? "asc",
      });
    } catch {
      /* noVault not ready yet — defaults are fine */
    }
  },

  refreshTree: async () => {
    try {
      const tree = await api.getFolderTree();
      // Prune device-local state of folders that no longer exist so it can't leak.
      const folders = new Set<string>();
      collectPaths(tree, folders);
      const s = get();
      const collapsed = new Set([...s.collapsed].filter((p) => folders.has(p)));
      const selectedFolder =
        s.selectedFolder && !folders.has(s.selectedFolder) ? null : s.selectedFolder;
      set({ tree, collapsed, selectedFolder });
    } catch (e) {
      // A noVault error here just means the engine isn't ready yet.
      if (!(e instanceof NovalisError && e.kind === "noVault")) {
        set({ error: displayError(e) });
      }
    }
  },

  openNote: async (path) => {
    // Highlight the clicked note immediately, regardless of load time. Opening
    // a note clears the explicit folder selection (so the next "New note"
    // targets this note's folder), reveals it, and records it as recent.
    const collapsed = new Set(get().collapsed);
    for (const a of ancestorsOf(path)) collapsed.delete(a);
    const recent = [path, ...get().recent.filter((p) => p !== path)].slice(0, getRecentLimit());
    set({ activePath: path, selectedFolder: null, collapsed, recent });
    persistSidebar(get);

    const cached = noteCache.get(path);
    if (cached) {
      set({ activeNote: cached });
      return;
    }
    // Not cached: leave the previous activeNote in place (EditorPane shows a
    // loading state because activeNote.path !== activePath) and fetch.
    try {
      const note = await fetchNote(path);
      // Race guard: only apply if the user hasn't since clicked another note.
      if (get().activePath === path) set({ activeNote: note });
    } catch (e) {
      if (get().activePath === path) set({ error: displayError(e) });
    }
  },

  prefetchNote: (path) => {
    if (noteCache.has(path) || inflight.has(path)) return;
    void fetchNote(path).catch(() => {});
  },

  invalidateNote: (path) => {
    noteCache.delete(path);
    inflight.delete(path);
  },

  newNote: async (folder, templateId) => {
    const base = folder ? `${folder}/` : "";
    for (let i = 1; i <= 50; i++) {
      const name = i === 1 ? "Untitled" : `Untitled ${i}`;
      try {
        const note = await api.createNote(
          `${base}${name}.md`,
          templateId ? { template: templateId } : undefined,
        );
        noteCache.set(note.path, note);
        // Make sure the destination folder is open so the new note is visible.
        const collapsed = new Set(get().collapsed);
        for (const a of ancestorsOf(note.path)) collapsed.delete(a);
        const recent = [note.path, ...get().recent.filter((p) => p !== note.path)].slice(
          0,
          getRecentLimit(),
        );
        set({ collapsed, recent });
        await get().refreshTree();
        set({ activePath: note.path, activeNote: note });
        persistSidebar(get);
        return;
      } catch (e) {
        if (e instanceof NovalisError && e.kind === "alreadyExists") continue;
        set({ error: displayError(e) });
        return;
      }
    }
  },

  deleteActive: async () => {
    const path = get().activePath;
    if (!path) return;
    try {
      await api.deleteNote(path);
      noteCache.delete(path);
      inflight.delete(path);
      set({ activePath: null, activeNote: null });
      await get().refreshTree();
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  saveNote: async (path, content) => {
    try {
      const note = await api.updateNote(path, content);
      // Keep the cache current so re-opening this note is instant.
      noteCache.set(path, note);
      // No refreshTree() here: a content save doesn't change the tree's shape,
      // and the file watcher re-indexes the written file and emits
      // `note-changed`, which refreshes the tree once (see useNovalisEvents).
      // Refreshing on every debounced keystroke-save was the main typing lag.
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  clearError: () => set({ error: null }),

  // ── Sidebar actions ───────────────────────────────────────────────────────

  selectFolder: (path) => {
    set({ selectedFolder: path });
    persistSidebar(get);
  },

  toggleCollapsed: (path) => {
    const collapsed = new Set(get().collapsed);
    if (collapsed.has(path)) collapsed.delete(path);
    else collapsed.add(path);
    set({ collapsed });
    persistSidebar(get);
  },

  collapseAll: () => {
    const tree = get().tree;
    if (!tree) return;
    const folders = new Set<string>();
    collectPaths(tree, folders);
    set({ collapsed: folders });
    persistSidebar(get);
  },

  expandAll: () => {
    set({ collapsed: new Set<string>() });
    persistSidebar(get);
  },

  revealPath: (path) => {
    const collapsed = new Set(get().collapsed);
    let changed = false;
    for (const a of ancestorsOf(path)) {
      if (collapsed.delete(a)) changed = true;
    }
    if (changed) {
      set({ collapsed });
      persistSidebar(get);
    }
  },

  setFolderColor: (path, color) => {
    const folderColors = { ...get().folderColors };
    if (color) folderColors[path] = color;
    else delete folderColors[path];
    set({ folderColors });
    void persistFileTree(get);
  },

  setSortMode: (sortBy, sortDir) => {
    set({ sortBy, ...(sortDir ? { sortDir } : {}) });
    void persistFileTree(get);
  },

  createFolder: async (parent, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const path = parent ? `${parent}/${trimmed}` : trimmed;
    try {
      await api.createFolder(path);
      const collapsed = new Set(get().collapsed);
      collapsed.delete(path);
      if (parent) for (const a of ancestorsOf(`${path}/x`)) collapsed.delete(a);
      set({ collapsed, selectedFolder: path });
      await get().refreshTree();
      persistSidebar(get);
    } catch (e) {
      if (e instanceof NovalisError && e.kind === "alreadyExists") {
        set({ error: i18n.t("vault:error.folderExists", { name: trimmed }) });
      } else {
        set({ error: displayError(e) });
      }
    }
  },

  renameItem: async (path, kind, newName) => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      if (kind === "note") {
        // Renaming a note changes its title (frontmatter). The filename/path
        // stays stable so links, order keys and the open editor keep working.
        const updated = await api.updateNoteMeta({
          path,
          title: trimmed,
          tags: null,
          pinned: null,
          aliases: null,
        });
        noteCache.set(path, updated);
        inflight.delete(path);
        if (get().activePath === path) set({ activeNote: updated });
        await get().refreshTree();
        return;
      }

      // Folder rename = directory move; migrate path-keyed prefs + view state.
      const parent = parentOf(path);
      const newPath = parent ? `${parent}/${trimmed}` : trimmed;
      if (newPath === path) return;
      await api.moveFolder(path, newPath);
      const { colors, order } = migratePrefsForMove(
        path,
        newPath,
        get().folderColors,
        get().itemOrder,
      );
      const collapsed = new Set([...get().collapsed].map((p) => prefixRewrite(p, path, newPath)));
      const activePath = get().activePath && prefixRewrite(get().activePath as string, path, newPath);
      const selectedFolder =
        get().selectedFolder && prefixRewrite(get().selectedFolder as string, path, newPath);
      set({ folderColors: colors, itemOrder: order, collapsed, activePath, selectedFolder });
      await persistFileTree(get);
      await get().refreshTree();
      persistSidebar(get);
    } catch (e) {
      if (e instanceof NovalisError && e.kind === "alreadyExists") {
        set({ error: i18n.t("vault:error.itemExistsHere", { name: trimmed }) });
      } else {
        set({ error: displayError(e) });
      }
    }
  },

  deleteFolder: async (path) => {
    const node = get().tree ? findFolder(get().tree as FolderNode, path) : null;
    const isEmpty = !!node && node.children.length === 0 && node.notes.length === 0;
    try {
      if (isEmpty) await api.deleteFolder(path);
      else await api.deleteFolderRecursive(path);

      // Drop colors/order for the removed subtree and clear active/selection.
      const folderColors = Object.fromEntries(
        Object.entries(get().folderColors).filter(
          ([k]) => k !== path && !k.startsWith(path + "/"),
        ),
      );
      const itemOrder = Object.fromEntries(
        Object.entries(get().itemOrder).filter(([k]) => k !== path && !k.startsWith(path + "/")),
      );
      const ap = get().activePath;
      const clearActive = ap === path || (ap && ap.startsWith(path + "/"));
      set({
        folderColors,
        itemOrder,
        selectedFolder: get().selectedFolder === path ? null : get().selectedFolder,
        ...(clearActive ? { activePath: null, activeNote: null } : {}),
      });
      await persistFileTree(get);
      await get().refreshTree();
      persistSidebar(get);
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  duplicateNote: async (path) => {
    try {
      const note = await api.duplicateNote(path);
      noteCache.set(note.path, note);
      await get().refreshTree();
      set({ activePath: note.path, activeNote: note });
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  togglePin: async (path, pinned) => {
    try {
      await api.updateNoteMeta({ path, pinned, title: null, tags: null, aliases: null });
      noteCache.delete(path);
      inflight.delete(path);
      await get().refreshTree();
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  moveItem: async (item, target) => {
    const src = item.path;
    const srcParent = parentOf(src);

    // Same-parent reorder: no filesystem change, just rewrite the manual order.
    if (target.type === "reorder" && target.folder === srcParent) {
      const tree = get().tree;
      if (!tree) return;
      const node = findFolder(tree, target.folder);
      if (!node) return;
      const keys = orderedItems(node, get().sortBy, get().sortDir, get().itemOrder).map(
        (i) => i.key,
      );
      const without = keys.filter((k) => k !== src);
      let idx = target.beforePath == null ? without.length : without.indexOf(target.beforePath);
      if (idx < 0) idx = without.length;
      without.splice(idx, 0, src);
      set({
        itemOrder: { ...get().itemOrder, [target.folder]: without },
        sortBy: "manual",
      });
      void persistFileTree(get);
      return;
    }

    // Otherwise reparent into the target folder. A "reorder" drop into a
    // different folder both moves the item AND places it at the drop position
    // in the destination's manual order.
    const destFolder = target.folder;
    if (item.kind === "folder" && (destFolder === src || destFolder.startsWith(src + "/"))) {
      return; // can't move a folder into itself or a descendant
    }
    const newPath = destFolder ? `${destFolder}/${basename(src)}` : basename(src);
    if (newPath === src) return; // dropped onto its own parent

    try {
      if (item.kind === "note") {
        await api.moveNote(src, newPath);
        if (noteCache.has(src)) {
          noteCache.delete(src);
          inflight.delete(src);
        }
      } else {
        await api.moveFolder(src, newPath);
      }
      const migrated = migratePrefsForMove(src, newPath, get().folderColors, get().itemOrder);
      const colors = migrated.colors;
      let order = migrated.order;

      // Precise cross-folder placement: seed the destination's order from its
      // current display order (the tree still holds pre-move siblings) and
      // splice the moved item in at the drop position.
      if (target.type === "reorder") {
        const tree = get().tree;
        const destNode = tree ? findFolder(tree, destFolder) : null;
        const destKeys = destNode
          ? orderedItems(destNode, get().sortBy, get().sortDir, order)
              .map((i) => i.key)
              .filter((k) => k !== src && k !== newPath)
          : [];
        let idx =
          target.beforePath == null ? destKeys.length : destKeys.indexOf(target.beforePath);
        if (idx < 0) idx = destKeys.length;
        destKeys.splice(idx, 0, newPath);
        order = { ...order, [destFolder]: destKeys };
      }

      const collapsed = new Set([...get().collapsed].map((p) => prefixRewrite(p, src, newPath)));
      collapsed.delete(destFolder); // reveal the destination
      const activePath = get().activePath && prefixRewrite(get().activePath as string, src, newPath);
      const selectedFolder =
        item.kind === "folder"
          ? newPath
          : get().selectedFolder && prefixRewrite(get().selectedFolder as string, src, newPath);
      set({
        folderColors: colors,
        itemOrder: order,
        collapsed,
        activePath,
        selectedFolder,
        ...(target.type === "reorder" ? { sortBy: "manual" as SortBy } : {}),
      });
      await persistFileTree(get);
      await get().refreshTree();
      persistSidebar(get);
    } catch (e) {
      if (e instanceof NovalisError && e.kind === "alreadyExists") {
        set({ error: i18n.t("vault:error.itemExistsTarget", { name: basename(src) }) });
      } else {
        set({ error: displayError(e) });
      }
    }
  },
}));
