import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Clock,
  Cloud,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Hash,
  Pin,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { COLOR_HEX, COLOR_TOKENS } from "../lib/colors";
import { flattenTree, type FlatTreeRow } from "../lib/flattenTree";
import i18n from "../lib/i18n";
import { api, type FolderNode, type NoteSummary, type NoteTemplate } from "../ipc/api";
import { flattenNotes } from "../lib/noteTree";
import { revealLabel } from "../lib/reveal";
import { type SortBy } from "../lib/treeOrder";
import { useDismiss } from "../lib/useDismiss";
import { useUi } from "../stores/uiStore";
import { newNoteFolder, useVault, type DragItem } from "../stores/vaultStore";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { ConfirmDialog } from "./ui/ConfirmDialog";

export type MainView = "notes" | "today" | "tasks" | "calendar" | "graph" | "query" | "canvas";

const iconBtn =
  "rounded-md p-1.5 text-fg-muted transition-colors hover:bg-active hover:text-fg";

// The currently-dragged item — kept in a module variable because the HTML5 DnD
// `dragover` event can't read `dataTransfer` payloads (only their types), yet we
// need the dragged path to validate drop targets and draw indicators live.
let currentDrag: DragItem | null = null;

function tagHue(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % 360;
  return h;
}

// ── Sidebar interaction context (menu / rename / new-folder / color / filter) ─
interface MenuTarget {
  kind: "note" | "folder";
  path: string;
  node?: FolderNode;
  note?: NoteSummary;
}
/** Tree state that changes while the user works (filter keystrokes, inline
 *  rename / new-folder sessions). Rows do NOT consume this context — VirtualTree
 *  narrows it into per-row props, so a filter keystroke re-runs the (cheap)
 *  flatten but leaves the memoized row components cached. */
interface SidebarTreeState {
  filter: string;
  renaming: string | null;
  newFolderParent: string | null | undefined; // undefined = inactive
}
/** Stable action bundle (every callback is memoized in Sidebar), safe for the
 *  memoized rows to consume without breaking their memo. */
interface SidebarActions {
  beginRename: (path: string) => void;
  endRename: () => void;
  beginNewFolder: (parent: string | null) => void;
  endNewFolder: () => void;
  openMenu: (pos: { x: number; y: number }, target: MenuTarget) => void;
}
const StateCtx = createContext<SidebarTreeState | null>(null);
const ActionsCtx = createContext<SidebarActions | null>(null);
const useSidebarState = (): SidebarTreeState => {
  const c = useContext(StateCtx);
  if (!c) throw new Error("SidebarTreeState missing");
  return c;
};
const useSidebarActions = (): SidebarActions => {
  const c = useContext(ActionsCtx);
  if (!c) throw new Error("SidebarActions missing");
  return c;
};

export function Sidebar({
  onOpenSettings,
  width,
}: {
  /** Opens the settings dialog (reached from the vault menu). */
  onOpenSettings: () => void;
  /** Explicit rail width in px (device pref). Falls back to a default. */
  width?: number;
}) {
  const tree = useVault((s) => s.tree);
  const vaultPath = useVault((s) => s.vaultPath);
  const collapseAll = useVault((s) => s.collapseAll);
  const moveItem = useVault((s) => s.moveItem);
  const vaultName = vaultPath ? vaultPath.split("/").filter(Boolean).pop() : "Vault";
  const { t } = useTranslation(["sidebar", "common", "trash"]);

  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newFolderParent, setNewFolderParent] = useState<string | null | undefined>(undefined);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [colorPicker, setColorPicker] = useState<{ x: number; y: number; path: string } | null>(
    null,
  );
  // Pending delete from the context menu, confirmed via ConfirmDialog.
  const [confirmTarget, setConfirmTarget] = useState<MenuTarget | null>(null);
  // The scroll element the virtualized tree measures against, and the block of
  // (variable-height) sections above it — the tree offsets itself past this
  // block via the virtualizer's `scrollMargin`.
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);

  // All callbacks are stable (setState functions are, and store access goes
  // through getState) so the memoized actions context never invalidates and
  // the React.memo on the rows can hold.
  const beginRename = useCallback((path: string) => {
    setNewFolderParent(undefined);
    setRenaming(path);
  }, []);
  const endRename = useCallback(() => setRenaming(null), []);
  const beginNewFolder = useCallback((parent: string | null) => {
    setRenaming(null);
    // Make sure the parent is expanded so the inline input is visible.
    if (parent) {
      const st = useVault.getState();
      if (st.collapsed.has(parent)) st.toggleCollapsed(parent);
    }
    setNewFolderParent(parent);
  }, []);
  const endNewFolder = useCallback(() => setNewFolderParent(undefined), []);
  const openMenu = useCallback(
    (pos: { x: number; y: number }, target: MenuTarget) =>
      setMenu({
        x: pos.x,
        y: pos.y,
        items: buildMenu(
          target,
          // Action bundle the menu builder closes over.
          {
            openColorPicker: (path, x, y) => setColorPicker({ x, y, path }),
            beginRename,
            beginNewFolder,
            requestDelete: (delTarget) => setConfirmTarget(delTarget),
          },
          pos.x,
          pos.y,
        ),
      }),
    [beginRename, beginNewFolder],
  );

  const actions = useMemo<SidebarActions>(
    () => ({ beginRename, endRename, beginNewFolder, endNewFolder, openMenu }),
    [beginRename, endRename, beginNewFolder, endNewFolder, openMenu],
  );
  const treeState = useMemo<SidebarTreeState>(
    () => ({ filter: filter.trim().toLowerCase(), renaming, newFolderParent }),
    [filter, renaming, newFolderParent],
  );

  // Vault switcher: recent vaults + "open another" + jump to Vault settings.
  const openVaultMenu = async (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const recent = await api.listRecentVaults().catch(() => []);
    const others = recent.filter((v) => v.path !== vaultPath).slice(0, 6);
    const items: MenuItem[] = [
      ...others.map((v) => ({
        label: v.path.split("/").filter(Boolean).pop() ?? v.path,
        onClick: () => void useVault.getState().switchVault(v.path),
      })),
      {
        label: t("vaultMenu.openAnother"),
        separatorBefore: others.length > 0,
        onClick: () => void useVault.getState().pickAndOpen(),
      },
      { label: t("vaultMenu.settings"), onClick: onOpenSettings },
    ];
    setMenu({ x: rect.left, y: rect.bottom + 4, items });
  };

  return (
    <aside
      style={{ width: width ?? 256 }}
      className="flex h-full shrink-0 flex-col border-r border-border/80 bg-surface/40"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/80 px-3 py-2.5">
        <button
          onClick={openVaultMenu}
          title={vaultPath ?? ""}
          className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-sm font-semibold text-fg transition-colors hover:bg-hover"
        >
          <span className="truncate">{vaultName}</span>
          <ChevronDown size={13} className="shrink-0 text-fg-subtle" />
        </button>
        <button title={t("refreshFromDisk")} onClick={() => void api.rescanVault()} className={`${iconBtn} shrink-0`}>
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Tree toolbar */}
      <div className="flex items-center justify-between px-2 py-1">
        <span className="px-1 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
          {t("notesHeading")}
        </span>
        <div className="flex items-center gap-0.5">
          <NewNoteButton />
          <button
            title={t("newFolder")}
            onClick={() => beginNewFolder(useVault.getState().selectedFolder)}
            className={iconBtn}
          >
            <FolderPlus size={15} />
          </button>
          <SortButton />
          <button title={t("collapseAll")} onClick={() => collapseAll()} className={iconBtn}>
            <ChevronsDownUp size={15} />
          </button>
        </div>
      </div>

      {/* Filter */}
      <div className="px-2 pb-1.5">
        <div className="flex items-center gap-1.5 rounded-md bg-surface-2/60 px-2 py-1">
          <Search size={12} className="shrink-0 text-fg-subtle" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setFilter("")}
            placeholder={t("filterPlaceholder")}
            className="w-full bg-transparent text-xs text-fg outline-none placeholder:text-fg-faint"
          />
          {filter && (
            <button onClick={() => setFilter("")} className="shrink-0 text-fg-subtle hover:text-fg">
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-1.5 pb-3"
        // Root drop zone: dropping in empty space moves the item to the vault root.
        onDragOver={(e) => {
          if (currentDrag) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (currentDrag) void moveItem(currentDrag, { type: "into", folder: "" });
        }}
      >
        <ActionsCtx.Provider value={actions}>
          <StateCtx.Provider value={treeState}>
            <div ref={headerRef}>
              <PinnedSection />
              <RecentSection />
              <TagsSection />
              {newFolderParent === null && <NewFolderInput parent={null} />}
            </div>
            {tree ? (
              <VirtualTree tree={tree} scrollRef={scrollRef} headerRef={headerRef} />
            ) : (
              <p className="px-3 py-2 text-xs text-fg-faint">{t("common:loading")}</p>
            )}
          </StateCtx.Provider>
        </ActionsCtx.Provider>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {colorPicker && (
        <ColorPopover
          x={colorPicker.x}
          y={colorPicker.y}
          path={colorPicker.path}
          onClose={() => setColorPicker(null)}
        />
      )}
      {confirmTarget && (
        <ConfirmDialog
          open
          danger
          title={
            confirmTarget.kind === "note"
              ? t("trash:trashConfirmTitle")
              : t("confirm.deleteFolderTitle")
          }
          body={
            confirmTarget.kind === "note"
              ? t("confirm.trashNote", { title: confirmTarget.note?.title ?? confirmTarget.path })
              : folderIsEmpty(confirmTarget.node)
                ? t("confirm.deleteEmptyFolder", { name: confirmTarget.node?.name })
                : t("confirm.trashFolder", { name: confirmTarget.node?.name })
          }
          confirmLabel={t("common:delete")}
          onConfirm={() => {
            setConfirmTarget(null);
            // Route through the store: it flushes pending edits into the
            // trashed copy and closes the deleted tabs in every pane.
            if (confirmTarget.kind === "note") void useVault.getState().deleteNote(confirmTarget.path);
            else void useVault.getState().deleteFolder(confirmTarget.path);
          }}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
    </aside>
  );
}

/** Is the folder node empty (no subfolders, no notes)? Drives the confirm copy
 *  — the store's deleteFolder makes the hard-delete/trash call itself. */
function folderIsEmpty(node: FolderNode | undefined): boolean {
  return !!node && node.children.length === 0 && node.notes.length === 0;
}

// ── Context-menu item builder ───────────────────────────────────────────────
interface CtxActions {
  openColorPicker: (path: string, x: number, y: number) => void;
  beginRename: (path: string) => void;
  beginNewFolder: (parent: string | null) => void;
  /** Ask the host to confirm (ConfirmDialog) and run the delete. */
  requestDelete: (target: MenuTarget) => void;
}

function buildMenu(target: MenuTarget, actions: CtxActions, x: number, y: number): MenuItem[] {
  const s = useVault.getState();
  if (target.kind === "note") {
    const note = target.note;
    const pinned = note?.pinned ?? false;
    return [
      { label: i18n.t("sidebar:menu.open"), onClick: () => useUi.getState().openInWorkspace(target.path) },
      { label: i18n.t("sidebar:menu.rename"), onClick: () => actions.beginRename(target.path) },
      { label: i18n.t("sidebar:menu.duplicate"), onClick: () => void s.duplicateNote(target.path) },
      {
        label: pinned ? i18n.t("sidebar:menu.unpin") : i18n.t("sidebar:menu.pin"),
        onClick: () => void s.togglePin(target.path, !pinned),
      },
      { label: revealLabel(), onClick: () => void s.revealInFileManager(target.path) },
      {
        label: i18n.t("sidebar:menu.delete"),
        danger: true,
        separatorBefore: true,
        onClick: () => actions.requestDelete(target),
      },
    ];
  }
  return [
    { label: i18n.t("sidebar:menu.newNoteHere"), onClick: () => void s.newNote(target.path) },
    { label: i18n.t("sidebar:menu.newSubfolder"), onClick: () => actions.beginNewFolder(target.path) },
    { label: i18n.t("sidebar:menu.rename"), onClick: () => actions.beginRename(target.path) },
    {
      label: i18n.t("sidebar:menu.setColor"),
      onClick: () => actions.openColorPicker(target.path, x, y),
    },
    { label: revealLabel(), onClick: () => void s.revealInFileManager(target.path) },
    {
      label: i18n.t("sidebar:menu.delete"),
      danger: true,
      separatorBefore: true,
      onClick: () => actions.requestDelete(target),
    },
  ];
}

// ── Header controls ─────────────────────────────────────────────────────────
function NewNoteButton() {
  const newNote = useVault((s) => s.newNote);
  const target = useVault((s) => newNoteFolder(s));
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const { t } = useTranslation("sidebar");
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void api.listTemplates().then(setTemplates).catch(() => setTemplates([]));
  };

  return (
    <div ref={ref} className="relative">
      <button
        title={target ? t("newNoteIn", { target }) : t("newNote")}
        onClick={toggle}
        className={iconBtn}
      >
        <Plus size={16} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-lg border border-border-strong/80 bg-surface p-1 shadow-xl">
          {target && (
            <p className="truncate px-2.5 py-1 text-[10px] uppercase tracking-wide text-fg-faint">
              {t("inFolder", { target })}
            </p>
          )}
          <button
            onClick={() => {
              setOpen(false);
              void newNote(target);
            }}
            className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-fg transition-colors hover:bg-hover"
          >
            {t("blankNote")}
          </button>
          {templates.map((tpl) => (
            <button
              key={tpl.id}
              onClick={() => {
                setOpen(false);
                void newNote(target, tpl.id);
              }}
              className="block w-full truncate rounded-md px-2.5 py-1.5 text-left text-xs text-fg-muted transition-colors hover:bg-hover"
            >
              {tpl.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SortButton() {
  const sortBy = useVault((s) => s.sortBy);
  const setSortMode = useVault((s) => s.setSortMode);
  const { t } = useTranslation("sidebar");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const opts: { label: string; by: SortBy; dir?: "asc" | "desc" }[] = [
    { label: t("sort.nameAsc"), by: "name", dir: "asc" },
    { label: t("sort.nameDesc"), by: "name", dir: "desc" },
    { label: t("sort.modified"), by: "modified", dir: "desc" },
    { label: t("sort.created"), by: "created", dir: "desc" },
    { label: t("sort.manual"), by: "manual" },
  ];
  return (
    <div ref={ref} className="relative">
      <button
        title={t("sortTitle", { mode: sortBy })}
        onClick={() => setOpen((v) => !v)}
        className={`${iconBtn} ${sortBy === "manual" ? "text-accent" : ""}`}
      >
        <ArrowDownUp size={15} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-lg border border-border-strong/80 bg-surface p-1 shadow-xl">
          {opts.map((o) => (
            <button
              key={o.label}
              onClick={() => {
                setOpen(false);
                setSortMode(o.by, o.dir);
              }}
              className={`block w-full rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-hover ${
                sortBy === o.by ? "text-accent" : "text-fg-muted"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ColorPopover({
  x,
  y,
  path,
  onClose,
}: {
  x: number;
  y: number;
  path: string;
  onClose: () => void;
}) {
  const setFolderColor = useVault((s) => s.setFolderColor);
  const current = useVault((s) => s.folderColors[path]);
  const { t } = useTranslation("sidebar");
  const ref = useRef<HTMLDivElement>(null);
  // Mounted only while open (the host renders it conditionally, like ContextMenu).
  useDismiss(ref, true, onClose);
  // Anchor near the cursor / viewport center when invoked from the menu.
  const left = x || Math.round(window.innerWidth / 2) - 90;
  const top = y || 120;
  return (
    <div
      ref={ref}
      style={{ left, top }}
      className="fixed z-50 flex items-center gap-1.5 rounded-lg border border-border-strong/80 bg-surface p-2 shadow-xl"
    >
      {COLOR_TOKENS.map((token) => (
        <button
          key={token}
          title={token}
          onClick={() => {
            setFolderColor(path, token);
            onClose();
          }}
          style={{ background: COLOR_HEX[token] }}
          className={`h-5 w-5 rounded-full transition-transform hover:scale-110 ${
            current === token ? "ring-2 ring-accent-fg ring-offset-2 ring-offset-surface" : ""
          }`}
        />
      ))}
      <button
        title={t("noColor")}
        onClick={() => {
          setFolderColor(path, null);
          onClose();
        }}
        className="flex h-5 w-5 items-center justify-center rounded-full border border-border-strong text-fg-muted hover:text-fg"
      >
        <X size={12} />
      </button>
    </div>
  );
}

// ── Pinned & Recent sections ────────────────────────────────────────────────
function PinnedSection() {
  const tree = useVault((s) => s.tree);
  const { t } = useTranslation("sidebar");
  const [open, setOpen] = useState(true);
  const pinned = useMemo(() => {
    if (!tree) return [];
    const all: NoteSummary[] = [];
    flattenNotes(tree, all);
    return all.filter((n) => n.pinned);
  }, [tree]);
  if (pinned.length === 0) return null;
  return (
    <SidebarSection title={t("pinned")} icon={<Pin size={11} />} open={open} onToggle={() => setOpen((v) => !v)}>
      {pinned.map((n) => (
        <FlatNoteRow key={n.path} note={n} />
      ))}
    </SidebarSection>
  );
}

function RecentSection() {
  const tree = useVault((s) => s.tree);
  const recent = useVault((s) => s.recent);
  const { t } = useTranslation("sidebar");
  const [open, setOpen] = useState(true);
  const items = useMemo(() => {
    if (!tree) return [];
    const all: NoteSummary[] = [];
    flattenNotes(tree, all);
    const byPath = new Map(all.map((n) => [n.path, n]));
    return recent.map((p) => byPath.get(p)).filter((n): n is NoteSummary => !!n).slice(0, 5);
  }, [tree, recent]);
  if (items.length === 0) return null;
  return (
    <SidebarSection title={t("recent")} icon={<Clock size={11} />} open={open} onToggle={() => setOpen((v) => !v)}>
      {items.map((n) => (
        <FlatNoteRow key={n.path} note={n} />
      ))}
    </SidebarSection>
  );
}

type TagNode =
  | { kind: "leaf"; tag: string; count: number }
  | { kind: "group"; name: string; count: number; children: { tag: string; count: number }[] };

/** Tag browser: distinct tags (frontmatter + inline `#tags`) with note counts,
 *  derived from the loaded tree. Tags are grouped by their first `/` segment
 *  into a two-level tree; selecting a leaf expands the notes carrying it. */
/** Top-level tag rows shown before the list is expanded — vaults with many
 *  tags otherwise stretch the sidebar into an endless scroll. */
const TAG_LIST_LIMIT = 12;

function TagsSection() {
  const tree = useVault((s) => s.tree);
  const { t } = useTranslation("sidebar");
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const { nodes, notesByTag } = useMemo(() => {
    const all: NoteSummary[] = [];
    if (tree) flattenNotes(tree, all);
    const counts = new Map<string, number>();
    const byTag = new Map<string, NoteSummary[]>();
    for (const n of all) {
      for (const tag of n.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
        const arr = byTag.get(tag);
        if (arr) arr.push(n);
        else byTag.set(tag, [n]);
      }
    }
    // Group by the segment before the first "/". Tags without "/" stay as
    // standalone top-level leaves.
    const groups = new Map<string, { tag: string; count: number }[]>();
    const standalone: { tag: string; count: number }[] = [];
    for (const [tag, count] of counts) {
      const slash = tag.indexOf("/");
      if (slash > 0) {
        const head = tag.slice(0, slash);
        const arr = groups.get(head);
        if (arr) arr.push({ tag, count });
        else groups.set(head, [{ tag, count }]);
      } else {
        standalone.push({ tag, count });
      }
    }
    const built: TagNode[] = [
      ...standalone.map((s): TagNode => ({ kind: "leaf", tag: s.tag, count: s.count })),
      ...[...groups.entries()].map(([name, children]): TagNode => ({
        kind: "group",
        name,
        count: children.reduce((acc, c) => acc + c.count, 0),
        children: children.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
      })),
    ].sort((a, b) => {
      const an = a.kind === "leaf" ? a.tag : a.name;
      const bn = b.kind === "leaf" ? b.tag : b.name;
      return b.count - a.count || an.localeCompare(bn);
    });
    return { nodes: built, notesByTag: byTag };
  }, [tree]);

  if (nodes.length === 0) return null;

  // Keep a selected tag reachable even when it sits past the cutoff.
  const visible =
    showAll || nodes.length <= TAG_LIST_LIMIT
      ? nodes
      : nodes.filter(
          (n, i) =>
            i < TAG_LIST_LIMIT ||
            (selected !== null &&
              (n.kind === "leaf"
                ? n.tag === selected
                : n.children.some((c) => c.tag === selected))),
        );

  const toggleSel = (tag: string) => setSelected((s) => (s === tag ? null : tag));
  const toggleGroup = (name: string) =>
    setCollapsedGroups((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <SidebarSection
      title={t("tags")}
      icon={<Hash size={11} />}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {visible.map((node) =>
        node.kind === "leaf" ? (
          <TagRow
            key={node.tag}
            tag={node.tag}
            display={`#${node.tag}`}
            count={node.count}
            selected={selected === node.tag}
            onSelect={() => toggleSel(node.tag)}
            notes={notesByTag.get(node.tag) ?? []}
          />
        ) : (
          <div key={`g:${node.name}`}>
            <button
              onClick={() => toggleGroup(node.name)}
              title={`#${node.name}/…`}
              className="flex w-full items-center gap-1 rounded-md py-1 pl-1.5 pr-2 text-left text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            >
              {collapsedGroups.has(node.name) ? (
                <ChevronRight size={12} className="shrink-0 text-fg-subtle" />
              ) : (
                <ChevronDown size={12} className="shrink-0 text-fg-subtle" />
              )}
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: `hsl(${tagHue(node.name)} 60% 60%)` }}
              />
              <span className="truncate">#{node.name}</span>
              <span className="ml-auto shrink-0 text-[10px] tabular-nums text-fg-faint">
                {node.count}
              </span>
            </button>
            {!collapsedGroups.has(node.name) && (
              <div className="ml-3">
                {node.children.map((c) => (
                  <TagRow
                    key={c.tag}
                    tag={c.tag}
                    display={c.tag.slice(node.name.length + 1)}
                    count={c.count}
                    selected={selected === c.tag}
                    onSelect={() => toggleSel(c.tag)}
                    notes={notesByTag.get(c.tag) ?? []}
                  />
                ))}
              </div>
            )}
          </div>
        ),
      )}
      {nodes.length > TAG_LIST_LIMIT && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="flex w-full items-center gap-1 rounded-md py-1 pl-1.5 pr-2 text-left text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          {showAll ? t("tagsShowFewer") : t("tagsShowAll", { total: nodes.length })}
        </button>
      )}
    </SidebarSection>
  );
}

/** One selectable tag row (standalone or a group child); expands to its notes. */
function TagRow({
  tag,
  display,
  count,
  selected,
  onSelect,
  notes,
}: {
  tag: string;
  display: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
  notes: NoteSummary[];
}) {
  return (
    <div>
      <button
        onClick={onSelect}
        title={`#${tag}`}
        className={`flex w-full items-center gap-1.5 rounded-md py-1 pl-3 pr-2 text-left text-sm transition-colors ${
          selected
            ? "bg-accent-soft font-medium text-accent"
            : "text-fg-muted hover:bg-hover hover:text-fg"
        }`}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: `hsl(${tagHue(tag)} 60% 60%)` }}
        />
        <span className="truncate">{display}</span>
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-fg-faint">{count}</span>
      </button>
      {selected && (
        <div className="mb-1 ml-3 border-l border-border/60 pl-1">
          {notes.map((n) => (
            <FlatNoteRow key={n.path} note={n} />
          ))}
        </div>
      )}
    </div>
  );
}

function SidebarSection({
  title,
  icon,
  open,
  onToggle,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-1">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle hover:text-fg-muted"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {icon}
        {title}
      </button>
      {open && <div>{children}</div>}
      <div className="mx-2 mt-1 border-b border-border/60" />
    </div>
  );
}

/** A note row for the Pinned/Recent sections — no tree depth or DnD. */
function FlatNoteRow({ note }: { note: NoteSummary }) {
  const activePath = useVault((s) => s.activePath);
  const openInWorkspace = useUi((s) => s.openInWorkspace);
  const prefetchNote = useVault((s) => s.prefetchNote);
  const active = activePath === note.path;
  return (
    <button
      onClick={(e) => openInWorkspace(note.path, { background: e.metaKey || e.ctrlKey })}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          openInWorkspace(note.path, { background: true });
        }
      }}
      onMouseEnter={() => prefetchNote(note.path)}
      title={note.path}
      className={`flex w-full items-center gap-1.5 rounded-md py-1 pl-3 pr-2 text-left text-sm transition-colors ${
        active ? "bg-accent-soft font-medium text-accent" : "text-fg-muted hover:bg-hover hover:text-fg"
      }`}
    >
      <FileText size={14} className="shrink-0 text-fg-subtle" />
      <span className="truncate">{note.title}</span>
    </button>
  );
}

// ── Tree ────────────────────────────────────────────────────────────────────
/** `data-tree-path` for a row, or null for the inline new-folder input. */
function pathOfRow(r: FlatTreeRow): string | null {
  return r.kind === "folder" ? r.folder.path : r.kind === "note" ? r.note.path : null;
}
/** A navigable (roving-tabindex) row — folders and notes, not the input row. */
function isTreeItemRow(r: FlatTreeRow): boolean {
  return r.kind === "folder" || r.kind === "note";
}
function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

/** The vault tree, virtualized. The currently-visible tree is flattened into a
 *  single ordered array (honoring sort, filter and per-folder collapse state)
 *  and only the on-screen rows are mounted — the initial mount is O(viewport),
 *  not O(vault). Every existing behavior is preserved by reusing the same
 *  `FolderRow`/`NoteRow` rows unchanged and driving arrow-key navigation and
 *  reveal off the flat model, so they can reach rows that aren't rendered yet
 *  (`scrollToIndex` mounts the target, then focus lands on it).
 *
 *  The rows share the sidebar's scroll element with the Pinned/Recent/Tags
 *  sections above them; `scrollMargin` offsets the virtual list past that
 *  (variable-height) block so everything still scrolls as one. */
function VirtualTree({
  tree,
  scrollRef,
  headerRef,
}: {
  tree: FolderNode;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  headerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useTranslation("sidebar");
  const sortBy = useVault((s) => s.sortBy);
  const sortDir = useVault((s) => s.sortDir);
  const itemOrder = useVault((s) => s.itemOrder);
  const collapsed = useVault((s) => s.collapsed);
  const activePath = useVault((s) => s.activePath);
  const { filter, renaming, newFolderParent } = useSidebarState();

  const rows = useMemo(
    () => flattenTree(tree, { sortBy, sortDir, itemOrder, collapsed, filter, newFolderParent }),
    [tree, sortBy, sortDir, itemOrder, collapsed, filter, newFolderParent],
  );

  const treeRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12,
    scrollMargin,
    getItemKey: (i) => rows[i].key,
  });

  // Keep `scrollMargin` equal to the tree's offset past the sections above it,
  // so item positions stay correct as those (collapsible) sections resize. Runs
  // before paint, so the measured margin is applied before the first frame.
  useLayoutEffect(() => {
    const measure = () => {
      const scrollEl = scrollRef.current;
      const treeEl = treeRef.current;
      if (!scrollEl || !treeEl) return;
      const margin =
        treeEl.getBoundingClientRect().top -
        scrollEl.getBoundingClientRect().top +
        scrollEl.scrollTop;
      setScrollMargin((prev) => (Math.abs(prev - margin) > 0.5 ? margin : prev));
    };
    measure();
    const header = headerRef.current;
    if (!header) return;
    const ro = new ResizeObserver(measure);
    ro.observe(header);
    return () => ro.disconnect();
  }, [scrollRef, headerRef]);

  const focusByPath = useCallback((path: string): boolean => {
    const el = treeRef.current?.querySelector<HTMLElement>(
      `[data-tree-path="${cssEscape(path)}"]`,
    );
    if (el) {
      el.focus();
      return true;
    }
    return false;
  }, []);

  // Move roving focus to a flat-model row, mounting it first if it's scrolled
  // out of the virtual window (up to two frames for the virtualizer to render).
  const navigateTo = useCallback(
    (targetIdx: number) => {
      if (targetIdx < 0 || targetIdx >= rows.length) return;
      const path = pathOfRow(rows[targetIdx]);
      if (!path) return;
      virtualizer.scrollToIndex(targetIdx, { align: "auto" });
      if (focusByPath(path)) return;
      requestAnimationFrame(() => {
        if (!focusByPath(path)) requestAnimationFrame(() => focusByPath(path));
      });
    },
    [rows, virtualizer, focusByPath],
  );

  // WAI-ARIA tree arrow-key navigation, driven off the flat model so it reaches
  // rows outside the render window. Enter / context-menu keys stay on the rows.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const key = e.key;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "ArrowRight" && key !== "ArrowLeft")
        return;
      const rowEl = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
      if (!rowEl) return;
      const path = rowEl.getAttribute("data-tree-path") ?? "";
      const idx = rows.findIndex((r) => isTreeItemRow(r) && pathOfRow(r) === path);
      if (idx < 0) return;
      e.preventDefault(); // keep arrows from scrolling the rail

      const cur = rows[idx];
      const nextTreeItem = (dir: 1 | -1): number => {
        for (let i = idx + dir; i >= 0 && i < rows.length; i += dir) {
          if (isTreeItemRow(rows[i])) return i;
        }
        return -1;
      };
      // A folder is shown open while filtering (forceOpen) or when not collapsed.
      const folderOpen = (p: string) => filter !== "" || !collapsed.has(p);

      if (key === "ArrowDown") {
        navigateTo(nextTreeItem(1));
      } else if (key === "ArrowUp") {
        navigateTo(nextTreeItem(-1));
      } else if (key === "ArrowRight") {
        if (cur.kind !== "folder") return;
        if (!folderOpen(cur.folder.path)) {
          useVault.getState().toggleCollapsed(cur.folder.path); // expand
        } else {
          const n = nextTreeItem(1);
          if (n >= 0 && rows[n].depth > cur.depth) navigateTo(n); // into first child
        }
      } else {
        // ArrowLeft: collapse an expanded folder, otherwise hop to the parent.
        if (cur.kind === "folder" && folderOpen(cur.folder.path)) {
          useVault.getState().toggleCollapsed(cur.folder.path);
        } else {
          for (let i = idx - 1; i >= 0; i--) {
            if (isTreeItemRow(rows[i]) && rows[i].depth < cur.depth) {
              navigateTo(i);
              break;
            }
          }
        }
      }
    },
    [rows, filter, collapsed, navigateTo],
  );

  // Reveal: when a note becomes active (opened from search / a wiki-link /
  // Recent), scroll its row into view even if it's outside the render window.
  // `openNote` expands the ancestors in the same update, so the row is present
  // in `rows` by the time this runs.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const prevActive = useRef<string | null>(null);
  useEffect(() => {
    if (activePath && activePath !== prevActive.current) {
      const idx = rowsRef.current.findIndex((r) => r.kind === "note" && r.note.path === activePath);
      if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
    }
    prevActive.current = activePath;
  }, [activePath, virtualizer]);

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label={t("notesHeading")}
      // The tree is a single tab stop: the container is tabbable and forwards
      // focus to the active (else first rendered) row; rows are tabIndex={-1}
      // and reached with the arrow keys.
      tabIndex={0}
      className="relative w-full outline-none"
      style={{ height: virtualizer.getTotalSize() }}
      onFocus={(e) => {
        if (e.target !== e.currentTarget) return; // a row got focus, not us
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        const active = e.currentTarget.querySelector<HTMLElement>(
          '[role="treeitem"][aria-selected="true"]',
        );
        (active ?? e.currentTarget.querySelector<HTMLElement>('[role="treeitem"]'))?.focus();
      }}
      onKeyDown={onKeyDown}
    >
      {virtualizer.getVirtualItems().map((vi) => {
        const row = rows[vi.index];
        return (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${vi.start - scrollMargin}px)`,
            }}
          >
            {row.kind === "folder" ? (
              <FolderRow
                node={row.folder}
                depth={row.depth}
                parentPath={row.parentPath}
                nextKey={row.nextKey}
                isRenaming={renaming === row.folder.path}
                forceOpen={filter !== ""}
                dragDisabled={renaming !== null}
              />
            ) : row.kind === "note" ? (
              <NoteRow
                note={row.note}
                depth={row.depth}
                parentPath={row.parentPath}
                nextKey={row.nextKey}
                isRenaming={renaming === row.note.path}
              />
            ) : (
              <NewFolderInput parent={row.parent} depth={row.depth} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Vertical zone of a drag-over within a row. */
function zoneOf(e: React.DragEvent, allowInto: boolean): "into" | "before" | "after" {
  const r = e.currentTarget.getBoundingClientRect();
  const rel = (e.clientY - r.top) / r.height;
  if (!allowInto) return rel < 0.5 ? "before" : "after";
  if (rel < 0.25) return "before";
  if (rel > 0.75) return "after";
  return "into";
}

function dragInvalidOnto(path: string): boolean {
  // A folder can't be dropped onto itself or a descendant; nothing drops onto itself.
  if (!currentDrag) return true;
  if (currentDrag.path === path) return true;
  if (currentDrag.kind === "folder" && path.startsWith(currentDrag.path + "/")) return true;
  return false;
}

const FolderRow = memo(function FolderRow({
  node,
  depth,
  parentPath,
  nextKey,
  isRenaming,
  forceOpen,
  dragDisabled,
}: {
  node: FolderNode;
  depth: number;
  parentPath: string;
  nextKey: string | null;
  isRenaming: boolean;
  forceOpen: boolean;
  dragDisabled: boolean;
}) {
  // Narrow, row-local store slices (booleans / own color) so unrelated
  // changes — another folder collapsing, the selection moving — don't
  // re-render every row.
  const collapsed = useVault((s) => s.collapsed.has(node.path));
  const selected = useVault((s) => s.selectedFolder === node.path);
  const color = useVault((s) => s.folderColors[node.path]);
  const selectFolder = useVault((s) => s.selectFolder);
  const toggleCollapsed = useVault((s) => s.toggleCollapsed);
  const moveItem = useVault((s) => s.moveItem);
  const newNote = useVault((s) => s.newNote);
  const { openMenu } = useSidebarActions();
  const { t } = useTranslation("sidebar");

  const open = forceOpen || !collapsed;
  const hex = color ? COLOR_HEX[color] : undefined;
  const noteCount = node.notes.length + node.children.length;
  const [zone, setZone] = useState<"into" | "before" | "after" | null>(null);

  if (isRenaming) {
    return <RenameInput path={node.path} kind="folder" initial={node.name} depth={depth} isFolder />;
  }

  const activate = () => {
    selectFolder(node.path);
    if (collapsed) toggleCollapsed(node.path);
  };
  const openRowMenu = (pos: { x: number; y: number }) =>
    openMenu(pos, { kind: "folder", path: node.path, node });

  return (
    <div>
      <div
        role="treeitem"
        aria-expanded={open}
        aria-level={depth + 1}
        tabIndex={-1}
        data-tree-path={node.path}
        draggable={!dragDisabled}
        onDragStart={(e) => {
          currentDrag = { kind: "folder", path: node.path };
          e.dataTransfer.setData("text/plain", JSON.stringify(currentDrag));
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => {
          currentDrag = null;
        }}
        onDragOver={(e) => {
          if (!currentDrag) return;
          // Block dropping onto the dragged folder itself or any descendant.
          if (dragInvalidOnto(node.path)) {
            if (zone) setZone(null);
            return;
          }
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setZone(zoneOf(e, true));
        }}
        onDragLeave={(e) => {
          // Only clear when truly leaving the row (not when crossing a child).
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZone(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setZone(null);
          if (!currentDrag || dragInvalidOnto(node.path)) return;
          const item = currentDrag;
          // Compute the zone from the drop event itself — reading React state
          // here is unreliable because dragleave/dragenter on child elements
          // races the value (currentTarget is always this row).
          const z = zoneOf(e, true);
          if (z === "into") void moveItem(item, { type: "into", folder: node.path });
          else if (z === "before") void moveItem(item, { type: "reorder", folder: parentPath, beforePath: node.path });
          else void moveItem(item, { type: "reorder", folder: parentPath, beforePath: nextKey });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openRowMenu({ x: e.clientX, y: e.clientY });
        }}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            activate();
          } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            openRowMenu({ x: r.left + 8, y: r.bottom });
          }
        }}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={`group relative flex w-full cursor-pointer items-center gap-1 rounded-md py-1 pr-1.5 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50 ${
          selected
            ? "bg-active text-fg"
            : "text-fg-muted hover:bg-hover hover:text-fg"
        } ${zone === "into" ? "ring-1 ring-inset ring-accent/50" : ""}`}
      >
        <IndentGuides depth={depth} />
        {/* Left accent bar in the folder's color. */}
        {hex && (
          <span
            className="absolute inset-y-0.5 left-0 w-0.5 rounded-full"
            style={{ background: hex }}
          />
        )}
        {zone === "before" && <DropLine top />}
        {zone === "after" && <DropLine />}
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleCollapsed(node.path);
          }}
          className="shrink-0 text-fg-subtle hover:text-fg-muted"
          tabIndex={-1}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {open ? (
          <FolderOpen size={14} className="shrink-0" style={{ color: hex ?? "#737373" }} />
        ) : (
          <Folder size={14} className="shrink-0" style={{ color: hex ?? "#737373" }} />
        )}
        <span className="flex-1 truncate">{node.name}</span>
        <button
          title={t("menu.newNoteHere")}
          onClick={(e) => {
            e.stopPropagation();
            void newNote(node.path);
          }}
          className="hidden shrink-0 rounded p-0.5 text-fg-subtle hover:bg-active hover:text-fg group-hover:block"
          tabIndex={-1}
        >
          <Plus size={13} />
        </button>
        {noteCount > 0 && (
          <span className="shrink-0 text-[10px] tabular-nums text-fg-faint group-hover:hidden">
            {noteCount}
          </span>
        )}
      </div>
      {/* Children are rendered as sibling rows by the flat virtualized list
          (VirtualTree), not recursively here. */}
    </div>
  );
});

const NoteRow = memo(function NoteRow({
  note,
  depth,
  parentPath,
  nextKey,
  isRenaming,
}: {
  note: NoteSummary;
  depth: number;
  parentPath: string;
  nextKey: string | null;
  isRenaming: boolean;
}) {
  // Row-local boolean instead of the whole activePath: switching notes only
  // re-renders the two affected rows, not every note in the tree.
  const active = useVault((s) => s.activePath === note.path);
  const openInWorkspace = useUi((s) => s.openInWorkspace);
  const prefetchNote = useVault((s) => s.prefetchNote);
  const moveItem = useVault((s) => s.moveItem);
  const { openMenu } = useSidebarActions();
  const [zone, setZone] = useState<"before" | "after" | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  // Reveal: when this note becomes active (e.g. opened from search / a wiki-link
  // / Recent), scroll its row into view. Ancestor folders are expanded in the
  // store's openNote, so the row is rendered by the time this runs.
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (isRenaming) {
    return <RenameInput path={note.path} kind="note" initial={note.title} depth={depth} />;
  }

  const openRowMenu = (pos: { x: number; y: number }) =>
    openMenu(pos, { kind: "note", path: note.path, note });

  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-selected={active}
      aria-level={depth + 1}
      tabIndex={-1}
      data-tree-path={note.path}
      draggable
      onDragStart={(e) => {
        currentDrag = { kind: "note", path: note.path };
        e.dataTransfer.setData("text/plain", JSON.stringify(currentDrag));
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        currentDrag = null;
      }}
      onDragOver={(e) => {
        if (!currentDrag || currentDrag.path === note.path) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setZone(zoneOf(e, false) as "before" | "after");
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setZone(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setZone(null);
        if (!currentDrag || currentDrag.path === note.path) return;
        const item = currentDrag;
        // Compute the zone from the event (state is racy across child enter/leave).
        const z = zoneOf(e, false);
        void moveItem(item, {
          type: "reorder",
          folder: parentPath,
          beforePath: z === "before" ? note.path : nextKey,
        });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        openRowMenu({ x: e.clientX, y: e.clientY });
      }}
      onClick={(e) => openInWorkspace(note.path, { background: e.metaKey || e.ctrlKey })}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          openInWorkspace(note.path, { background: e.metaKey || e.ctrlKey });
        } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          openRowMenu({ x: r.left + 8, y: r.bottom });
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          openInWorkspace(note.path, { background: true });
        }
      }}
      onMouseEnter={() => prefetchNote(note.path)}
      title={note.path}
      style={{ paddingLeft: 24 + depth * 12 }}
      className={`group relative flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50 ${
        active ? "bg-accent-soft font-medium text-accent" : "text-fg-muted hover:bg-hover hover:text-fg"
      }`}
    >
      <IndentGuides depth={depth} />
      {zone === "before" && <DropLine top />}
      {zone === "after" && <DropLine />}
      <FileText size={14} className="shrink-0 text-fg-subtle" />
      <span className="flex-1 truncate">{note.title}</span>
      <NoteBadges note={note} />
    </div>
  );
});

function NoteBadges({ note }: { note: NoteSummary }) {
  const { t } = useTranslation("sidebar");
  return (
    <span className="flex shrink-0 items-center gap-1">
      {note.tags.slice(0, 2).map((tag) => (
        <span
          key={tag}
          title={`#${tag}`}
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: `hsl(${tagHue(tag)} 60% 60%)` }}
        />
      ))}
      {note.cloudOnly && (
        <Cloud size={12} className="text-sky-400/70" aria-label={t("cloudOnly")} />
      )}
      {note.pinned && <Pin size={11} className="text-amber-400/80" />}
      {note.taskTotal > 0 && (
        <span
          className={`rounded px-1 text-[10px] tabular-nums ${
            note.taskCompleted === note.taskTotal
              ? "bg-emerald-500/15 text-emerald-300/80"
              : "bg-hover text-fg-muted"
          }`}
        >
          {note.taskCompleted}/{note.taskTotal}
        </span>
      )}
    </span>
  );
}

function DropLine({ top }: { top?: boolean }) {
  return (
    <span
      className={`pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-accent ${
        top ? "top-0" : "bottom-0"
      }`}
    />
  );
}

/** Vertical rails marking each ancestor depth level, so nesting reads clearly.
 *  One rail per ancestor, aligned to that ancestor's chevron gutter; stacked
 *  rows at the same depth share an x, forming continuous lines. */
function IndentGuides({ depth }: { depth: number }) {
  if (depth <= 0) return null;
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span
          key={i}
          className="pointer-events-none absolute inset-y-0 w-px bg-border-strong/40"
          style={{ left: 14 + i * 12 }}
        />
      ))}
    </>
  );
}

// ── Inline inputs ───────────────────────────────────────────────────────────
function NewFolderInput({ parent, depth = 0 }: { parent: string | null; depth?: number }) {
  const createFolder = useVault((s) => s.createFolder);
  const { endNewFolder } = useSidebarActions();
  const { t } = useTranslation("sidebar");
  const [name, setName] = useState("");
  const commit = () => {
    const n = name.trim();
    if (n) void createFolder(parent, n);
    endNewFolder();
  };
  return (
    <div className="flex items-center gap-1 py-0.5" style={{ paddingLeft: 8 + depth * 12 }}>
      <FolderPlus size={14} className="shrink-0 text-fg-subtle" />
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") endNewFolder();
        }}
        onBlur={commit}
        placeholder={t("folderNamePlaceholder")}
        className="w-full rounded bg-surface-2 px-1.5 py-0.5 text-sm text-fg outline-none placeholder:text-fg-faint"
      />
    </div>
  );
}

function RenameInput({
  path,
  kind,
  initial,
  depth,
  isFolder,
}: {
  path: string;
  kind: "note" | "folder";
  initial: string;
  depth: number;
  isFolder?: boolean;
}) {
  const renameItem = useVault((s) => s.renameItem);
  const { endRename } = useSidebarActions();
  const [name, setName] = useState(initial);
  const commit = () => {
    renameItem(path, kind, name);
    endRename();
  };
  return (
    <div
      className="flex items-center gap-1 py-0.5"
      style={{ paddingLeft: (isFolder ? 8 : 24) + depth * 12 }}
    >
      {isFolder ? (
        <Folder size={14} className="shrink-0 text-fg-subtle" />
      ) : (
        <FileText size={14} className="shrink-0 text-fg-subtle" />
      )}
      <input
        autoFocus
        value={name}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") endRename();
        }}
        onBlur={commit}
        className="w-full rounded bg-surface-2 px-1.5 py-0.5 text-sm text-fg outline-none"
      />
    </div>
  );
}
