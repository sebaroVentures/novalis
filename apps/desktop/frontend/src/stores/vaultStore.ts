import { create } from "zustand";

import { api, NovalisError, type FolderNode, type Note, type PropertyValue } from "../ipc/api";
import { displayError } from "../lib/errors";
import i18n from "../lib/i18n";
import {
  getRecentLimit,
  loadSidebarPrefs,
  saveSidebarPrefs,
} from "../lib/sidebarPrefs";
import { findFolder, orderedItems, type SortBy } from "../lib/treeOrder";
import { useAgenda } from "./agendaStore";
import { useCalendar } from "./calendarStore";
// uiStore owns the tab workspace; vaultStore notifies it after path-changing
// ops (rename/move/delete) so tabs follow. The import is a benign cycle: both
// stores reference each other ONLY inside action bodies, never at module init.
import { useUi } from "./uiStore";

// In-memory note cache + in-flight de-dup. Kept outside the store so reads/
// prefetches don't trigger re-renders; only `activeNote` drives the editor.
// Reading a OneDrive "online-only" note hydrates it over the network (~1s), so
// caching + prefetch-on-hover is what makes opening feel instant.
const noteCache = new Map<string, Note>();
const inflight = new Map<string, Promise<Note>>();

// The last content we *requested* to write per path. Makes a repeated save of
// identical content a no-op — so a redundant flush after navigation costs
// nothing, and idle autosaves don't churn the file.
const lastRequest = new Map<string, string>();
// The in-flight write per path. A deduped re-save (same content) AWAITS the
// real write instead of reporting "saved" early — otherwise a flush-then-check
// sequence (closeTab's surfaceSaveError bail, switchVault's guard) could pass
// while the actual write is still pending and about to fail.
const writeInFlight = new Map<string, Promise<void>>();

// Each live editor (pane) registers its pending-autosave hooks here, keyed by
// pane id. Every navigation that changes the open note(s) calls `flushAll()`
// first, so edits made in the last debounce window are persisted to the
// *outgoing* note before we switch — closing the silent data-loss path on
// sidebar/search/palette/pane navigation. A Map (not a single callback) so
// multiple panes / a canvas / nested editors can register without clobbering —
// the seam every multi-editor feature builds on.
// - `flush` persists the pane's pending edit now.
// - `pendingPath` reports which path (if any) the pane has unflushed edits for,
//   so mirror-on-save can skip remounting a pane that is mid-edit.
// - `discard` drops the pending edit WITHOUT saving — for content the user (or
//   an external delete) explicitly threw away.
export interface PaneFlush {
  flush: () => Promise<void>;
  pendingPath: () => string | null;
  discard: () => void;
}
const flushRegistry = new Map<string, PaneFlush>();
async function flushAll(): Promise<void> {
  // Sequential, not Promise.all: two panes can (in a race window) hold pending
  // edits for the SAME path, and concurrent writes to one file would be
  // last-writer-wins with indeterminate order.
  for (const entry of flushRegistry.values()) await entry.flush();
}
/** True while any pane holds an unflushed edit for `path` — a debounced
 *  autosave snapshot or live typing the editor's serialize debounce hasn't
 *  captured yet (see PaneFlush.pendingPath). The per-path save state turns
 *  "dirty" only after that debounce, so this is the source of truth for edits
 *  made inside the debounce window. */
function hasPendingEdit(path: string): boolean {
  for (const entry of flushRegistry.values()) {
    if (entry.pendingPath() === path) return true;
  }
  return false;
}

// Set while stepping through back/forward history, so openNote doesn't record
// the navigation as a new history entry.
let navigatingHistory = false;

// Monotonic token for adoptFocusedNote: rapid pane-focus changes flush
// concurrently, and a slow earlier adoption must not overwrite the alias set
// by a newer one (last-call-wins on activePath/activeNote).
let adoptSeq = 0;

// Set while a vault switch is opening, so a second switch can't race the backend
// Engine swap and leave `vaultPath` out of sync with the open vault.
let switching = false;

/** Save lifecycle for a note, surfaced as a status indicator. */
export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/** Is `path` the visible (active-tab) note of any pane? */
function isVisibleInAnyPane(path: string): boolean {
  return useUi.getState().workspace.panes.some((p) => p.activeTab === path);
}

/** Write `note` into the per-path open-notes map (the content source every
 *  pane's editor reads), keeping the focused-pane alias `activeNote` in sync. */
function patchOpenNote(
  get: () => VaultState,
  set: (partial: Partial<VaultState>) => void,
  path: string,
  note: Note,
): void {
  const openNotes = new Map(get().openNotes);
  openNotes.set(path, note);
  set({ openNotes, ...(get().activePath === path ? { activeNote: note } : {}) });
}

/** Bump the remount epoch of every pane whose visible note is `path`. The
 *  editor key includes the epoch, so a bump remounts that pane's editor with
 *  the current `openNotes` content.
 *  - `excludePaneId`: the pane that produced the change (the typing source
 *    must never remount mid-edit).
 *  - `skipPending`: also spare panes that hold their OWN unflushed edit for
 *    the path (mirror-on-save must not wipe a pane the user is typing in —
 *    its content converges on its own next flush). External clean-adopt also
 *    passes it — it only runs when no pane has a pending edit (a pending edit
 *    takes handleExternalChange's conflict path), so this is a structural
 *    guard, not a behavior fork. Reload passes false: there the pending edit
 *    is being deliberately discarded (the pane's epoch-discard effect drops
 *    it). */
function bumpPaneEpochs(
  get: () => VaultState,
  set: (partial: Partial<VaultState>) => void,
  path: string,
  opts?: { excludePaneId?: string; skipPending?: boolean },
): void {
  const targets = useUi.getState().workspace.panes.filter(
    (p) =>
      p.activeTab === path &&
      p.id !== opts?.excludePaneId &&
      !(opts?.skipPending && flushRegistry.get(p.id)?.pendingPath() === path),
  );
  if (targets.length === 0) return;
  const paneEpochs = new Map(get().paneEpochs);
  for (const p of targets) paneEpochs.set(p.id, (paneEpochs.get(p.id) ?? 0) + 1);
  set({ paneEpochs });
}

/** Write a path's save state (and optional error) into the per-path maps,
 *  replacing the Map refs so zustand selectors re-run. Per-path (not "is this
 *  the active note") so a background tab's save/dirty/error is tracked too. */
function patchSave(
  get: () => VaultState,
  set: (partial: Partial<VaultState>) => void,
  path: string,
  state: SaveState,
  error: string | null = null,
): void {
  const saveStates = new Map(get().saveStates);
  saveStates.set(path, state);
  const saveErrors = new Map(get().saveErrors);
  if (error) saveErrors.set(path, error);
  else saveErrors.delete(path);
  set({ saveStates, saveErrors });
}

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
  /** The FOCUSED pane's open note path/content (history, recents, sidebar
   *  highlight and palette actions all track the focused pane). `activeNote` is
   *  kept as an alias of `openNotes.get(activePath)`. */
  activePath: string | null;
  activeNote: Note | null;
  /** Loaded content per open (visible) note path — what each pane's editor
   *  renders. Replaced-on-write so selectors re-run. */
  openNotes: Map<string, Note>;
  /** Per-pane remount epoch: bumped to force ONE pane's editor to remount with
   *  fresh content (external reload / mirror-on-save) — never the pane that is
   *  typing. Part of every pane's editor key. */
  paneEpochs: Map<string, number>;
  loading: boolean;
  error: string | null;

  // Save lifecycle, keyed by note path (a tab strip surfaces each tab's state;
  // the editor reads the active path's). Absent ⇒ "idle".
  saveStates: Map<string, SaveState>;
  saveErrors: Map<string, string>;
  /** Set when the open note changed on disk while it has unsaved edits. Single:
   *  it's the active-note banner, and the live editor shows exactly one note. */
  externalChange: string | null;

  // Sidebar view-state (device-local).
  collapsed: Set<string>;
  selectedFolder: string | null;
  recent: string[];
  /** Back/forward navigation history of opened note paths + the current index. */
  history: string[];
  historyIndex: number;
  // Folder appearance / order (vault-synced via Preferences).
  folderColors: Record<string, string>;
  itemOrder: Record<string, string[]>;
  sortBy: SortBy;
  sortDir: "asc" | "desc";

  /** Sync UI state with whatever vault the backend currently has open. */
  sync: () => Promise<void>;
  pickAndOpen: () => Promise<void>;
  /** Ask for a location, generate the bundled Novalis Tour demo vault there,
   *  then open it. Returns whether a tour was created (false if cancelled). */
  takeTour: () => Promise<boolean>;
  openVault: (path: string) => Promise<void>;
  /** Switch the active vault to `path`: flush pending edits, then open + reload. */
  switchVault: (path: string) => Promise<void>;
  refreshTree: () => Promise<void>;
  openNote: (path: string) => Promise<void>;
  /** Point the live-note alias (activePath/activeNote) at the focused pane's
   *  active tab after a WORKSPACE change (pane focus/close/split). Always
   *  flushes first; unlike `openNote` it records no history/recents and leaves
   *  sidebar state alone — focusing a pane is not a navigation. `null` clears. */
  adoptFocusedNote: (path: string | null) => Promise<void>;
  /** Step back/forward through the navigation history. */
  navBack: () => Promise<void>;
  navForward: () => Promise<void>;
  /** Rewrite/prune the navigation history through `map` (path → new path, or
   *  null to drop) after a rename/move/delete, so back/forward never targets a
   *  stale path. Called from uiStore.reconcileTabs (the single chokepoint). */
  reconcileHistory: (map: (path: string) => string | null) => void;
  /** Warm the cache (and OneDrive hydration) for a note, e.g. on hover. */
  prefetchNote: (path: string) => void;
  /** Drop a cached note (e.g. on external change/delete) so it re-reads. */
  invalidateNote: (path: string) => void;
  /** Ensure `path`'s content is in `openNotes` (cache hit or fetch) WITHOUT the
   *  navigation side effects of `openNote` — how a non-focused pane loads its
   *  visible note. */
  loadNote: (path: string) => Promise<void>;
  newNote: (folder: string, templateId?: string) => Promise<void>;
  /** Trash a note wherever it is open: flush first, delete, close its tabs in
   *  every pane. */
  deleteNote: (path: string) => Promise<void>;
  /** Persist `content` for `path`. `sourcePaneId` is the pane whose editor
   *  produced it — every OTHER pane showing the path remounts on success
   *  (mirror-on-save), the source never does. */
  saveNote: (path: string, content: string, sourcePaneId?: string) => Promise<void>;
  /** A pane's editor registers its pending-autosave hooks (keyed by pane id) so
   *  navigation can drain/inspect/discard every open editor. Pass `null` to
   *  unregister. */
  registerFlush: (paneId: string, entry: PaneFlush | null) => void;
  /** Drain every pane's pending autosave now (e.g. before the window closes). */
  flushActive: () => Promise<void>;
  /** Drop (without saving) any pane's pending autosave for `path` — for notes
   *  deleted externally, where flushing would resurrect the file. */
  discardPending: (path: string) => void;
  /** If `path`'s last save failed, surface that error and return true (callers
   *  bail instead of unmounting the editor that still holds the only copy). */
  surfaceSaveError: (path: string) => boolean;
  /** Mark a note (by path) as having unsaved edits (editor calls this on input). */
  markDirty: (path: string) => void;
  /** Drop a path's per-path save state (e.g. when its tab closes). */
  dropSaveState: (path: string) => void;
  /** Drop open-note content + save state for every path NOT in `keep` (the set
   *  of all open tab paths) — called whenever tabs/panes close. */
  pruneNoteState: (keep: Set<string>) => void;
  /** Clear the live editor (no note open) — used when the last tab closes. */
  clearActive: () => void;
  /** Reload `path` from disk, discarding in-editor changes, and remount every
   *  pane showing it. */
  reloadNote: (path: string) => Promise<void>;
  /** Reload the focused pane's note from disk (version restore, etc.). */
  reloadActive: () => Promise<void>;
  /** React to a watcher `note-changed` for the active note: ignore our own
   *  write echo, auto-reload when clean, or prompt when there are unsaved edits. */
  handleExternalChange: (path: string) => Promise<void>;
  /** Dismiss the "changed on disk" prompt without reloading. */
  dismissExternalChange: () => void;
  /** Surface a failure in the global error toast (App.tsx) — the shared error
   *  surface other stores/components route user-initiated action errors
   *  through (same `displayError` shape as vaultStore's own failures). */
  reportError: (e: unknown) => void;
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
  setNoteMeta: (path: string, meta: { tags?: string[]; aliases?: string[] }) => Promise<void>;
  /** Custom frontmatter properties (the typed `extra` view). All three flush
   *  pending body edits FIRST (the write rewrites the whole file) and update
   *  open content WITHOUT remounting any editor. */
  setProperty: (path: string, key: string, value: PropertyValue) => Promise<void>;
  removeProperty: (path: string, key: string) => Promise<void>;
  renameProperty: (path: string, from: string, to: string) => Promise<void>;
  deleteFolder: (path: string) => Promise<void>;
  duplicateNote: (path: string) => Promise<void>;
  /** Reveal a note file or folder in the OS file manager. Distinct from
   *  `revealPath`, which only expands the sidebar tree. */
  revealInFileManager: (path: string) => Promise<void>;
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
  openNotes: new Map<string, Note>(),
  paneEpochs: new Map<string, number>(),
  loading: true,
  error: null,

  saveStates: new Map<string, SaveState>(),
  saveErrors: new Map<string, string>(),
  externalChange: null,

  collapsed: new Set<string>(),
  selectedFolder: null,
  recent: [],
  history: [],
  historyIndex: -1,
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
    if (path) await get().switchVault(path);
  },

  takeTour: async () => {
    const parent = await api.pickVaultFolder();
    if (!parent) return false;
    let vaultPath: string;
    try {
      vaultPath = await api.createTourVault(parent);
    } catch (e) {
      get().reportError(e);
      return false;
    }
    await get().switchVault(vaultPath);
    // Only report success once the vault actually opened (switchVault bails
    // and surfaces its own error on failure, leaving vaultPath unchanged).
    return get().vaultPath === vaultPath;
  },

  switchVault: async (path) => {
    // Serialize switches: a second switch racing an in-flight one would race the
    // backend Engine swap and could leave `vaultPath` out of sync with the engine.
    if (switching) return;
    switching = true;
    try {
      // Drain the active editor's pending autosave to the *outgoing* vault first,
      // so edits made in the last debounce window survive the switch.
      await get().flushActive();
      // If any open note's autosave failed, the edit is still unsaved — tearing
      // the vault down here would lose it irrecoverably (the old engine closes).
      // Surface the error and stay put so the user can retry against the vault.
      // (Per-path now: flushActive drains every pane, so check all open paths,
      // not just the formerly-"active" one.)
      const failed = [...get().saveStates.entries()].find(([, s]) => s === "error");
      if (failed) {
        set({ error: get().saveErrors.get(failed[0]) ?? get().error });
        return;
      }
      // Fail loud if the target folder is gone rather than silently recreating an
      // empty vault there (open_vault_impl would `ensure_vault_dir` it back).
      try {
        await api.validateVault(path);
      } catch (e) {
        set({ error: displayError(e) });
        return;
      }
      await get().openVault(path);
      // openVault only sets `vaultPath` on success — bail if the switch failed
      // (the previous vault stays open and the error is already surfaced).
      if (get().vaultPath !== path) return;
      // openVault resets all vault-scoped state, and the backend `reindexed-event`
      // refreshes the tree, tasks, and conflicts (see useNovalisEvents). The lazy
      // calendar/agenda stores aren't covered, so drop the previous vault's data
      // here; each refetches when its view is next opened.
      useCalendar.getState().reset();
      useAgenda.getState().reset();
    } finally {
      switching = false;
    }
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
        openNotes: new Map<string, Note>(),
        paneEpochs: new Map<string, number>(),
        saveStates: new Map<string, SaveState>(),
        saveErrors: new Map<string, string>(),
        externalChange: null,
        collapsed: new Set<string>(),
        selectedFolder: null,
        recent: [],
        history: [],
        historyIndex: -1,
        folderColors: {},
        itemOrder: {},
      });
      // Discard any pending edits that re-armed while the switch was in flight
      // (switchVault already flushed + error-bailed BEFORE the engine swap):
      // the engine now points at the NEW vault, and the unmount cleanup-save
      // would otherwise write the OLD vault's content into a same-named file
      // here. Pre-switch behavior (discard, contained to the old vault) wins.
      for (const entry of flushRegistry.values()) entry.discard();
      // Clear the old vault's tabs immediately (no persist — that would clobber
      // the NEW vault's saved layout, which App's vaultPath effect then restores
      // via loadWorkspace).
      useUi.getState().resetWorkspace();
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
    // Flush the outgoing note's pending autosave to *its* path before switching,
    // so edits made in the last debounce window are never dropped.
    await flushAll();
    // Highlight the clicked note immediately, regardless of load time. Opening
    // a note clears the explicit folder selection (so the next "New note"
    // targets this note's folder), reveals it, and records it as recent.
    const collapsed = new Set(get().collapsed);
    for (const a of ancestorsOf(path)) collapsed.delete(a);
    const recent = [path, ...get().recent.filter((p) => p !== path)].slice(0, getRecentLimit());
    // Record navigation history, unless stepping through it via back/forward.
    let { history, historyIndex } = get();
    if (!navigatingHistory && history[historyIndex] !== path) {
      history = [...history.slice(0, historyIndex + 1), path];
      historyIndex = history.length - 1;
    }
    // The external-change banner is per-path now (it stays for whichever pane
    // still shows that note); pruneNoteState clears it when the tab closes.
    set({
      activePath: path,
      selectedFolder: null,
      collapsed,
      recent,
      history,
      historyIndex,
    });
    // Fresh-open shows no stale badge — but never mask a failed save (the
    // pending edit is retained for retry and the user must see it).
    if (get().saveStates.get(path) !== "error") patchSave(get, set, path, "idle");
    persistSidebar(get);

    const cached = noteCache.get(path);
    if (cached) {
      patchOpenNote(get, set, path, cached);
      return;
    }
    // Not cached: the pane shows a loading state (openNotes has no entry for
    // the path yet — or a stale one that invalidateNote dropped) and we fetch.
    try {
      const note = await fetchNote(path);
      // Apply only while the path is still open (its tab may have closed
      // mid-fetch — pruneNoteState already dropped its entries).
      if (useUi.getState().isPathOpen(path)) patchOpenNote(get, set, path, note);
    } catch (e) {
      if (get().activePath === path) set({ error: displayError(e) });
    }
  },

  adoptFocusedNote: async (path) => {
    const seq = ++adoptSeq;
    // Always flush — even when the focused pane shows the SAME note as before
    // (two panes on one note): the newly focused pane must mirror the other
    // pane's just-typed content before the user can edit on a stale base.
    await flushAll();
    // A newer focus adoption superseded this one while we flushed: the flush
    // side effects stand (idempotent), but the alias is last-call-wins.
    if (seq !== adoptSeq) return;
    if (path === null) {
      if (get().activePath !== null) get().clearActive();
      return;
    }
    const note = get().openNotes.get(path) ?? noteCache.get(path) ?? null;
    // No history/recents/sidebar mutation, no save-state reset: the path was
    // already open; only the alias moves. A missing note self-heals via the
    // pane's loadNote effect.
    set({ activePath: path, activeNote: note });
  },

  loadNote: async (path) => {
    const cached = noteCache.get(path);
    if (cached) {
      if (get().openNotes.get(path) !== cached) patchOpenNote(get, set, path, cached);
      return;
    }
    try {
      const note = await fetchNote(path);
      // Only surface it if the path is still open somewhere (tab may have
      // closed while the fetch was in flight).
      if (useUi.getState().isPathOpen(path)) patchOpenNote(get, set, path, note);
    } catch (e) {
      if (useUi.getState().isPathOpen(path)) set({ error: displayError(e) });
    }
  },

  navBack: async () => {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const target = history[historyIndex - 1];
    navigatingHistory = true;
    try {
      await get().openNote(target);
      set({ historyIndex: historyIndex - 1 });
    } finally {
      navigatingHistory = false;
    }
    // Keep the tab strip's active tab in sync (openNote loads but doesn't touch
    // the workspace; the note is already loaded so don't re-open it).
    useUi.getState().activateTab(target);
  },

  navForward: async () => {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const target = history[historyIndex + 1];
    navigatingHistory = true;
    try {
      await get().openNote(target);
      set({ historyIndex: historyIndex + 1 });
    } finally {
      navigatingHistory = false;
    }
    useUi.getState().activateTab(target);
  },

  reconcileHistory: (map) => {
    const { history, historyIndex } = get();
    const cur = history[historyIndex];
    const next: string[] = [];
    for (const p of history) {
      const m = map(p);
      // Map through, dropping closed paths and collapsing adjacent duplicates.
      if (m && next[next.length - 1] !== m) next.push(m);
    }
    const mappedCur = cur != null ? map(cur) : null;
    let idx = mappedCur ? next.lastIndexOf(mappedCur) : -1;
    if (idx < 0) idx = next.length - 1; // current entry dropped → clamp to end
    set({ history: next, historyIndex: idx });
  },

  prefetchNote: (path) => {
    if (noteCache.has(path) || inflight.has(path)) return;
    void fetchNote(path).catch(() => {});
  },

  invalidateNote: (path) => {
    noteCache.delete(path);
    inflight.delete(path);
    lastRequest.delete(path);
    // Also drop stale open-note content — but never for a VISIBLE note: that
    // would unmount its live editor mid-edit (and lose the pending autosave).
    // A visible note is refreshed through reloadNote/handleExternalChange,
    // which swap content and remount via an epoch bump instead.
    if (get().openNotes.has(path) && !isVisibleInAnyPane(path)) {
      const openNotes = new Map(get().openNotes);
      openNotes.delete(path);
      set({ openNotes });
    }
  },

  newNote: async (folder, templateId) => {
    // Don't lose pending edits in the currently-open note when creating another.
    await flushAll();
    const base = folder ? `${folder}/` : "";
    for (let i = 1; i <= 50; i++) {
      const name = i === 1 ? "Untitled" : `Untitled ${i}`;
      try {
        const note = await api.createNote(
          `${base}${name}.md`,
          templateId ? { template: templateId } : undefined,
        );
        noteCache.set(note.path, note);
        await get().refreshTree();
        // Open as a tab in the focused pane (openNote does the folder-reveal,
        // recent/history, per-path save state, and loads from cache).
        useUi.getState().openInWorkspace(note.path);
        return;
      } catch (e) {
        if (e instanceof NovalisError && e.kind === "alreadyExists") continue;
        set({ error: displayError(e) });
        return;
      }
    }
  },

  deleteNote: async (path) => {
    // Flush first so the trashed copy reflects the latest edits (a restore then
    // brings back the most recent content).
    await flushAll();
    // If that flush failed, trashing now would save a STALE copy (a later
    // restore loses the last edit window). Surface the error and bail so the
    // user can retry — mirrors switchVault's guard.
    if (get().saveStates.get(path) === "error") {
      set({ error: get().saveErrors.get(path) ?? get().error });
      return;
    }
    try {
      await api.deleteNote(path);
      get().invalidateNote(path);
      await get().refreshTree();
      // The file is gone: close its tab in EVERY pane. reconcileTabs focuses a
      // neighbor (or empties the pane), re-syncs the live note, and prunes the
      // path's open-note/save state.
      useUi.getState().reconcileTabs((p) => (p === path ? null : p));
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  saveNote: async (path, content, sourcePaneId) => {
    // Idempotent: skip writing content identical to the last request for this
    // path (a redundant flush after navigation, or an idle autosave, is free).
    // If that identical write is still IN FLIGHT, wait for its true outcome —
    // callers that flush-then-check (close/switch bails) must not see a
    // premature "saved" for a write that is about to fail.
    if (lastRequest.get(path) === content) {
      const inflightWrite = writeInFlight.get(path);
      if (inflightWrite) {
        await inflightWrite;
        return;
      }
      patchSave(get, set, path, "saved");
      return;
    }
    lastRequest.set(path, content);
    // Per-path (not "is this the active note"): a background tab's flush updates
    // ITS save state, and a background save error surfaces on that tab — not as a
    // global banner for a note the user isn't looking at.
    patchSave(get, set, path, "saving");
    const write = (async () => {
      try {
        const note = await api.updateNote(path, content);
        // Keep the cache current so re-opening this note is instant.
        noteCache.set(path, note);
        // No refreshTree() here: a content save doesn't change the tree's shape,
        // and the file watcher re-indexes the written file and emits
        // `note-changed`, which refreshes the tree once (see useNovalisEvents).
        // Refreshing on every debounced keystroke-save was the main typing lag.
        patchSave(get, set, path, "saved");
        // Our write just overwrote whatever the external-change banner offered to
        // reload — the conflict is resolved in our favor; a stale banner would
        // advertise a "Reload" of our own content.
        if (get().externalChange === path) set({ externalChange: null });
        // Mirror-on-save: if the note is visible in other panes, refresh their
        // content and remount them. The source pane (the one typing) and any
        // pane holding its own pending edit for the path are spared — a pane
        // mid-typing must never be wiped by a sibling's save.
        if (isVisibleInAnyPane(path)) {
          patchOpenNote(get, set, path, note);
          bumpPaneEpochs(get, set, path, { excludePaneId: sourcePaneId, skipPending: true });
        }
      } catch (e) {
        lastRequest.delete(path); // allow retrying the same content
        patchSave(get, set, path, "error", displayError(e));
      }
    })();
    writeInFlight.set(path, write);
    try {
      await write;
    } finally {
      if (writeInFlight.get(path) === write) writeInFlight.delete(path);
    }
  },

  registerFlush: (paneId, entry) => {
    if (entry) flushRegistry.set(paneId, entry);
    else flushRegistry.delete(paneId);
  },

  flushActive: async () => {
    await flushAll();
  },

  discardPending: (path) => {
    for (const entry of flushRegistry.values()) {
      if (entry.pendingPath() === path) entry.discard();
    }
  },

  surfaceSaveError: (path) => {
    if (get().saveStates.get(path) !== "error") return false;
    set({ error: get().saveErrors.get(path) ?? get().error });
    return true;
  },

  markDirty: (path) => {
    if ((get().saveStates.get(path) ?? "idle") !== "dirty") patchSave(get, set, path, "dirty");
  },

  dropSaveState: (path) => {
    if (!get().saveStates.has(path) && !get().saveErrors.has(path)) return;
    const saveStates = new Map(get().saveStates);
    saveStates.delete(path);
    const saveErrors = new Map(get().saveErrors);
    saveErrors.delete(path);
    set({ saveStates, saveErrors });
  },

  pruneNoteState: (keep) => {
    const s = get();
    const stale = (m: Map<string, unknown>) => [...m.keys()].some((k) => !keep.has(k));
    if (stale(s.openNotes)) {
      const openNotes = new Map([...s.openNotes].filter(([k]) => keep.has(k)));
      set({ openNotes });
    }
    if (stale(s.saveStates) || stale(s.saveErrors)) {
      const saveStates = new Map([...s.saveStates].filter(([k]) => keep.has(k)));
      const saveErrors = new Map([...s.saveErrors].filter(([k]) => keep.has(k)));
      set({ saveStates, saveErrors });
    }
    if (s.externalChange && !keep.has(s.externalChange)) set({ externalChange: null });
  },

  clearActive: () => set({ activePath: null, activeNote: null }),

  reloadNote: async (path) => {
    // The user chose the disk content: drop any pane's pending autosave for
    // the path FIRST, or an armed debounce timer could fire during the fetch
    // and write the discarded edits back over what was just adopted.
    get().discardPending(path);
    noteCache.delete(path);
    inflight.delete(path);
    lastRequest.delete(path);
    try {
      const note = await fetchNote(path);
      if (!useUi.getState().isPathOpen(path)) return; // tab closed mid-fetch
      patchOpenNote(get, set, path, note);
      // Adopting disk content everywhere: remount EVERY pane showing the path
      // (a pane's own pending edit was deliberately discarded by the user —
      // its epoch-discard effect drops it).
      bumpPaneEpochs(get, set, path);
      patchSave(get, set, path, "idle");
      if (get().externalChange === path) set({ externalChange: null });
    } catch (e) {
      // Even a failed reload must remount the panes: their editors are in the
      // post-discard suppressed state, and only a remount resolves it.
      bumpPaneEpochs(get, set, path);
      if (useUi.getState().isPathOpen(path)) set({ error: displayError(e) });
    }
  },

  reloadActive: async () => {
    const path = get().activePath;
    if (!path) return;
    await get().reloadNote(path);
  },

  handleExternalChange: async (path) => {
    if (!isVisibleInAnyPane(path)) return;
    let disk: Note;
    try {
      // Read fresh from disk (bypasses the frontend cache).
      disk = await api.getNote(path);
    } catch {
      return;
    }
    if (!isVisibleInAnyPane(path)) return; // its tab(s) closed meanwhile
    const cached = noteCache.get(path);
    // Self-write echo (our own save re-fires the watcher) or no real change.
    if (cached && cached.content === disk.content) return;
    // Unsaved edits: let the user choose rather than clobber either side. The
    // per-path save state alone is NOT enough — it turns "dirty" only after
    // the editor's serialize debounce, so a watcher event landing inside that
    // window would look clean while a pane holds live typing. The flush
    // registry (hasPendingEdit) covers exactly that window, plus a pending
    // edit retained for retry after a failed save.
    if ((get().saveStates.get(path) ?? "idle") === "dirty" || hasPendingEdit(path)) {
      set({ externalChange: path });
    } else {
      // Clean: adopt the external content and remount every pane showing it.
      // skipPending mirrors mirror-on-save so an actively-editing pane can
      // never be wiped by the bump (none exists here — see the guard above).
      noteCache.set(path, disk);
      patchOpenNote(get, set, path, disk);
      bumpPaneEpochs(get, set, path, { skipPending: true });
      if (get().externalChange === path) set({ externalChange: null });
      patchSave(get, set, path, "idle");
    }
  },

  dismissExternalChange: () => set({ externalChange: null }),

  reportError: (e) => set({ error: displayError(e) }),

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
        // Refresh the open content in every pane showing it (no remount — the
        // body is unchanged, only frontmatter title).
        if (get().openNotes.has(path)) patchOpenNote(get, set, path, updated);
        await get().refreshTree();
        return;
      }

      // Folder rename = directory move; migrate path-keyed prefs + view state.
      const parent = parentOf(path);
      const newPath = parent ? `${parent}/${trimmed}` : trimmed;
      if (newPath === path) return;
      // Drain pending edits before the dir move renames the active note's path.
      await flushAll();
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
      // Renamed folder ⇒ its notes' paths changed: rewrite open tabs to match.
      useUi.getState().reconcileTabs((p) => prefixRewrite(p, path, newPath));
      persistSidebar(get);
    } catch (e) {
      if (e instanceof NovalisError && e.kind === "alreadyExists") {
        set({ error: i18n.t("vault:error.itemExistsHere", { name: trimmed }) });
      } else {
        set({ error: displayError(e) });
      }
    }
  },

  // Update a note's frontmatter tags/aliases. Like the note-rename branch, this
  // updates the open content WITHOUT bumping any pane epoch, so the open editor
  // keeps its cursor/scroll (no remount). Passing an empty array clears the
  // field; omitting it leaves the field unchanged.
  setNoteMeta: async (path, meta) => {
    try {
      const updated = await api.updateNoteMeta({
        path,
        title: null,
        tags: meta.tags ?? null,
        pinned: null,
        aliases: meta.aliases ?? null,
      });
      noteCache.set(path, updated);
      if (get().openNotes.has(path)) patchOpenNote(get, set, path, updated);
      await get().refreshTree();
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  // Custom-property writes rewrite the whole .md file, so the pending body
  // autosave is flushed INSIDE each action (un-skippable at call sites —
  // unlike setNoteMeta, whose ChipInput callers flush via commitMeta). Like
  // setNoteMeta they update the open content WITHOUT bumping any pane epoch:
  // the body is unchanged, and a remount would drop the cursor.
  setProperty: async (path, key, value) => {
    await flushAll();
    try {
      const updated = await api.setProperty(path, key, value);
      noteCache.set(path, updated);
      if (get().openNotes.has(path)) patchOpenNote(get, set, path, updated);
      await get().refreshTree();
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  removeProperty: async (path, key) => {
    await flushAll();
    try {
      const updated = await api.removeProperty(path, key);
      noteCache.set(path, updated);
      if (get().openNotes.has(path)) patchOpenNote(get, set, path, updated);
      await get().refreshTree();
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  renameProperty: async (path, from, to) => {
    await flushAll();
    try {
      const updated = await api.renameProperty(path, from, to);
      noteCache.set(path, updated);
      if (get().openNotes.has(path)) patchOpenNote(get, set, path, updated);
      await get().refreshTree();
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  deleteFolder: async (path) => {
    // Flush first so trashed copies reflect the latest edits (mirrors
    // deleteNote — a restore otherwise misses the last debounce window).
    await flushAll();
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
      // Close tabs for any deleted note (the folder and everything under it).
      useUi.getState().reconcileTabs((p) => (p === path || p.startsWith(path + "/") ? null : p));
      persistSidebar(get);
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  duplicateNote: async (path) => {
    await flushAll();
    try {
      const note = await api.duplicateNote(path);
      noteCache.set(note.path, note);
      await get().refreshTree();
      useUi.getState().openInWorkspace(note.path);
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  // Read-only OS action — deliberately does NOT flush (unlike duplicate/delete),
  // so an unsaved edit won't block revealing; the command falls back to the
  // parent folder if the file isn't on disk yet.
  revealInFileManager: async (path) => {
    try {
      await api.revealInFileManager(path);
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  togglePin: async (path, pinned) => {
    try {
      const updated = await api.updateNoteMeta({
        path,
        pinned,
        title: null,
        tags: null,
        aliases: null,
      });
      // Keep the cache hot (like renameItem/setNoteMeta): a deleted cache entry
      // would defeat handleExternalChange's self-write echo check, yielding a
      // spurious conflict banner (dirty) or a cursor-losing remount (clean).
      noteCache.set(path, updated);
      inflight.delete(path);
      if (get().openNotes.has(path)) patchOpenNote(get, set, path, updated);
      await get().refreshTree();
    } catch (e) {
      set({ error: displayError(e) });
    }
  },

  moveItem: async (item, target) => {
    // Drain the active editor's pending autosave to its still-current path
    // before any on-disk rename, so edits typed in the last debounce window
    // survive the move (matches openNote/newNote/deleteActive/switchVault). The
    // same-parent reorder branch below pays nothing — flush is idempotent.
    await flushAll();
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
      // Moved note/folder ⇒ paths changed: rewrite open tabs to the new paths.
      useUi.getState().reconcileTabs((p) => prefixRewrite(p, src, newPath));
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
