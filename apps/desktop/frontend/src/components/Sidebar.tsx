import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

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
  PanelLeftClose,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { COLOR_HEX, COLOR_TOKENS } from "../lib/colors";
import i18n from "../lib/i18n";
import { api, type FolderNode, type NoteSummary, type NoteTemplate } from "../ipc/api";
import { orderedItems, type SortBy, type TreeItem } from "../lib/treeOrder";
import { newNoteFolder, useVault, type DragItem } from "../stores/vaultStore";
import { ContextMenu, type MenuItem } from "./ContextMenu";

export type MainView = "notes" | "today" | "tasks" | "calendar";

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
interface SidebarCtx {
  filter: string;
  renaming: string | null;
  beginRename: (path: string) => void;
  endRename: () => void;
  newFolderParent: string | null | undefined; // undefined = inactive
  beginNewFolder: (parent: string | null) => void;
  endNewFolder: () => void;
  openMenu: (e: React.MouseEvent, target: MenuTarget) => void;
}
const Ctx = createContext<SidebarCtx | null>(null);
const useSidebarCtx = (): SidebarCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error("SidebarCtx missing");
  return c;
};

export function Sidebar({
  view,
  onViewChange,
  onOpenSearch,
  onOpenSettings,
  onOpenTrash,
  width,
  onCollapse,
}: {
  view: MainView;
  onViewChange: (v: MainView) => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenTrash: () => void;
  /** Explicit rail width in px (device pref). Falls back to a default. */
  width?: number;
  /** Collapse the rail on desktop (hidden via the host); shown only when set. */
  onCollapse?: () => void;
}) {
  const tree = useVault((s) => s.tree);
  const vaultPath = useVault((s) => s.vaultPath);
  const collapseAll = useVault((s) => s.collapseAll);
  const moveItem = useVault((s) => s.moveItem);
  const vaultName = vaultPath ? vaultPath.split("/").filter(Boolean).pop() : "Vault";
  const { t } = useTranslation(["sidebar", "common", "trash"]);
  const viewLabels: Record<MainView, string> = {
    notes: t("common:views.notes"),
    today: t("common:views.today"),
    tasks: t("common:views.tasks"),
    calendar: t("common:views.calendar"),
  };

  const [filter, setFilter] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newFolderParent, setNewFolderParent] = useState<string | null | undefined>(undefined);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [colorPicker, setColorPicker] = useState<{ x: number; y: number; path: string } | null>(
    null,
  );

  const ctx: SidebarCtx = {
    filter: filter.trim().toLowerCase(),
    renaming,
    beginRename: (path) => {
      setNewFolderParent(undefined);
      setRenaming(path);
    },
    endRename: () => setRenaming(null),
    newFolderParent,
    beginNewFolder: (parent) => {
      setRenaming(null);
      // Make sure the parent is expanded so the inline input is visible.
      if (parent) {
        const st = useVault.getState();
        if (st.collapsed.has(parent)) st.toggleCollapsed(parent);
      }
      setNewFolderParent(parent);
    },
    endNewFolder: () => setNewFolderParent(undefined),
    openMenu: (e, target) =>
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: buildMenu(target, ctxActions, e.clientX, e.clientY),
      }),
  };

  // Action bundle the menu builder closes over.
  const ctxActions = {
    openColorPicker: (path: string, x: number, y: number) => setColorPicker({ x, y, path }),
    beginRename: ctx.beginRename,
    beginNewFolder: ctx.beginNewFolder,
  };

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
        <div className="flex items-center gap-0.5">
          <button title={t("searchShortcut")} onClick={onOpenSearch} className={iconBtn}>
            <Search size={16} />
          </button>
          <button title={t("refreshFromDisk")} onClick={() => void api.rescanVault()} className={iconBtn}>
            <RefreshCw size={16} />
          </button>
          <button title={t("settings")} onClick={onOpenSettings} className={iconBtn}>
            <Settings size={16} />
          </button>
          {onCollapse && (
            <button
              title={t("collapseSidebar")}
              onClick={onCollapse}
              className={`${iconBtn} hidden md:inline-flex`}
            >
              <PanelLeftClose size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-1 p-2 pb-1">
        {/* eslint-disable-next-line i18next/no-literal-string -- view ids (logic keys); labels come from viewLabels */}
        {(["notes", "today", "tasks", "calendar"] as const).map((v) => (
          <button
            key={v}
            onClick={() => onViewChange(v)}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium capitalize transition-colors ${
              view === v
                ? "bg-active text-fg shadow-sm ring-1 ring-border"
                : "text-fg-muted hover:bg-hover hover:text-fg"
            }`}
          >
            {viewLabels[v]}
          </button>
        ))}
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
            onClick={() => ctx.beginNewFolder(useVault.getState().selectedFolder)}
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
        <Ctx.Provider value={ctx}>
          <PinnedSection />
          <RecentSection />
          <TagsSection />
          {newFolderParent === null && <NewFolderInput parent={null} />}
          {tree ? (
            <TreeChildren node={tree} depth={0} />
          ) : (
            <p className="px-3 py-2 text-xs text-fg-faint">{t("common:loading")}</p>
          )}
        </Ctx.Provider>
      </div>

      {/* Recently deleted lives at the bottom as a destination, not a toolbar tool. */}
      <div className="border-t border-border/80 p-1.5">
        <button
          onClick={onOpenTrash}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <Trash2 size={15} className="shrink-0" />
          <span className="truncate">{t("trash:title")}</span>
        </button>
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
    </aside>
  );
}

// ── Context-menu item builder ───────────────────────────────────────────────
interface CtxActions {
  openColorPicker: (path: string, x: number, y: number) => void;
  beginRename: (path: string) => void;
  beginNewFolder: (parent: string | null) => void;
}

function buildMenu(target: MenuTarget, actions: CtxActions, x: number, y: number): MenuItem[] {
  const s = useVault.getState();
  if (target.kind === "note") {
    const note = target.note;
    const pinned = note?.pinned ?? false;
    return [
      { label: i18n.t("sidebar:menu.open"), onClick: () => void s.openNote(target.path) },
      { label: i18n.t("sidebar:menu.rename"), onClick: () => actions.beginRename(target.path) },
      { label: i18n.t("sidebar:menu.duplicate"), onClick: () => void s.duplicateNote(target.path) },
      {
        label: pinned ? i18n.t("sidebar:menu.unpin") : i18n.t("sidebar:menu.pin"),
        onClick: () => void s.togglePin(target.path, !pinned),
      },
      {
        label: i18n.t("sidebar:menu.delete"),
        danger: true,
        separatorBefore: true,
        onClick: () => {
          if (!window.confirm(i18n.t("sidebar:confirm.trashNote", { title: note?.title ?? target.path }))) {
            return;
          }
          if (s.activePath === target.path) {
            // Route through the store so pending edits flush into the trashed copy.
            void s.deleteActive();
          } else {
            void api.deleteNote(target.path).then(() => {
              s.invalidateNote(target.path);
              void s.refreshTree();
            });
          }
        },
      },
    ];
  }
  const node = target.node;
  const empty = !!node && node.children.length === 0 && node.notes.length === 0;
  return [
    { label: i18n.t("sidebar:menu.newNoteHere"), onClick: () => void s.newNote(target.path) },
    { label: i18n.t("sidebar:menu.newSubfolder"), onClick: () => actions.beginNewFolder(target.path) },
    { label: i18n.t("sidebar:menu.rename"), onClick: () => actions.beginRename(target.path) },
    {
      label: i18n.t("sidebar:menu.setColor"),
      onClick: () => actions.openColorPicker(target.path, x, y),
    },
    {
      label: i18n.t("sidebar:menu.delete"),
      danger: true,
      separatorBefore: true,
      onClick: () => {
        const msg = empty
          ? i18n.t("sidebar:confirm.deleteEmptyFolder", { name: node?.name })
          : i18n.t("sidebar:confirm.trashFolder", { name: node?.name });
        if (window.confirm(msg)) void s.deleteFolder(target.path);
      },
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

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void api.listTemplates().then(setTemplates).catch(() => setTemplates([]));
  };

  return (
    <div className="relative">
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
  const opts: { label: string; by: SortBy; dir?: "asc" | "desc" }[] = [
    { label: t("sort.nameAsc"), by: "name", dir: "asc" },
    { label: t("sort.nameDesc"), by: "name", dir: "desc" },
    { label: t("sort.modified"), by: "modified", dir: "desc" },
    { label: t("sort.created"), by: "created", dir: "desc" },
    { label: t("sort.manual"), by: "manual" },
  ];
  return (
    <div className="relative">
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
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);
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
function flattenNotes(node: FolderNode, out: NoteSummary[]): void {
  for (const n of node.notes) out.push(n);
  for (const c of node.children) flattenNotes(c, out);
}

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

/** Tag browser: distinct tags (frontmatter + inline `#tags`) with note counts,
 *  derived from the loaded tree. Selecting a tag expands the notes carrying it. */
function TagsSection() {
  const tree = useVault((s) => s.tree);
  const { t } = useTranslation("sidebar");
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const { tags, notesByTag } = useMemo(() => {
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
    const sorted = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    return { tags: sorted, notesByTag: byTag };
  }, [tree]);

  if (tags.length === 0) return null;

  return (
    <SidebarSection
      title={t("tags")}
      icon={<Hash size={11} />}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      {tags.map(([tag, count]) => (
        <div key={tag}>
          <button
            onClick={() => setSelected((s) => (s === tag ? null : tag))}
            title={`#${tag}`}
            className={`flex w-full items-center gap-1.5 rounded-md py-1 pl-3 pr-2 text-left text-sm transition-colors ${
              selected === tag
                ? "bg-accent-soft font-medium text-accent"
                : "text-fg-muted hover:bg-hover hover:text-fg"
            }`}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: `hsl(${tagHue(tag)} 60% 60%)` }}
            />
            <span className="truncate">#{tag}</span>
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-fg-faint">
              {count}
            </span>
          </button>
          {selected === tag && (
            <div className="mb-1 ml-3 border-l border-border/60 pl-1">
              {(notesByTag.get(tag) ?? []).map((n) => (
                <FlatNoteRow key={n.path} note={n} />
              ))}
            </div>
          )}
        </div>
      ))}
    </SidebarSection>
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
  const openNote = useVault((s) => s.openNote);
  const prefetchNote = useVault((s) => s.prefetchNote);
  const active = activePath === note.path;
  return (
    <button
      onClick={() => void openNote(note.path)}
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
function noteMatches(n: NoteSummary, q: string): boolean {
  return n.title.toLowerCase().includes(q);
}
function folderMatches(node: FolderNode, q: string): boolean {
  if (node.name.toLowerCase().includes(q)) return true;
  if (node.notes.some((n) => noteMatches(n, q))) return true;
  return node.children.some((c) => folderMatches(c, q));
}

function TreeChildren({ node, depth }: { node: FolderNode; depth: number }) {
  const sortBy = useVault((s) => s.sortBy);
  const sortDir = useVault((s) => s.sortDir);
  const itemOrder = useVault((s) => s.itemOrder);
  const { filter, newFolderParent } = useSidebarCtx();

  let items: TreeItem[] = orderedItems(node, sortBy, sortDir, itemOrder);
  if (filter) {
    items = items.filter((it) =>
      it.kind === "note" ? noteMatches(it.note, filter) : folderMatches(it.folder, filter),
    );
  }

  return (
    <>
      {items.map((it, idx) =>
        it.kind === "folder" ? (
          <FolderRow
            key={it.key}
            node={it.folder}
            depth={depth}
            parentPath={node.path}
            nextKey={items[idx + 1]?.key ?? null}
          />
        ) : (
          <NoteRow
            key={it.key}
            note={it.note}
            depth={depth}
            parentPath={node.path}
            nextKey={items[idx + 1]?.key ?? null}
          />
        ),
      )}
      {/* Inline "new subfolder" input rendered at the end of its parent. */}
      {newFolderParent === node.path && node.path !== "" && (
        <NewFolderInput parent={node.path} depth={depth} />
      )}
    </>
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

function FolderRow({
  node,
  depth,
  parentPath,
  nextKey,
}: {
  node: FolderNode;
  depth: number;
  parentPath: string;
  nextKey: string | null;
}) {
  const collapsedSet = useVault((s) => s.collapsed);
  const selectedFolder = useVault((s) => s.selectedFolder);
  const color = useVault((s) => s.folderColors[node.path]);
  const selectFolder = useVault((s) => s.selectFolder);
  const toggleCollapsed = useVault((s) => s.toggleCollapsed);
  const moveItem = useVault((s) => s.moveItem);
  const newNote = useVault((s) => s.newNote);
  const ctx = useSidebarCtx();
  const { t } = useTranslation("sidebar");

  const forceOpen = ctx.filter !== "";
  const open = forceOpen || !collapsedSet.has(node.path);
  const selected = selectedFolder === node.path;
  const hex = color ? COLOR_HEX[color] : undefined;
  const noteCount = node.notes.length + node.children.length;
  const [zone, setZone] = useState<"into" | "before" | "after" | null>(null);

  if (ctx.renaming === node.path) {
    return <RenameInput path={node.path} kind="folder" initial={node.name} depth={depth} isFolder />;
  }

  return (
    <div>
      <div
        draggable={!ctx.renaming}
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
          ctx.openMenu(e, { kind: "folder", path: node.path, node });
        }}
        onClick={() => {
          selectFolder(node.path);
          if (collapsedSet.has(node.path)) toggleCollapsed(node.path);
        }}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={`group relative flex w-full cursor-pointer items-center gap-1 rounded-md py-1 pr-1.5 text-left text-sm font-medium transition-colors ${
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
      {open && <TreeChildren node={node} depth={depth + 1} />}
    </div>
  );
}

function NoteRow({
  note,
  depth,
  parentPath,
  nextKey,
}: {
  note: NoteSummary;
  depth: number;
  parentPath: string;
  nextKey: string | null;
}) {
  const activePath = useVault((s) => s.activePath);
  const openNote = useVault((s) => s.openNote);
  const prefetchNote = useVault((s) => s.prefetchNote);
  const moveItem = useVault((s) => s.moveItem);
  const ctx = useSidebarCtx();
  const active = activePath === note.path;
  const [zone, setZone] = useState<"before" | "after" | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  // Reveal: when this note becomes active (e.g. opened from search / a wiki-link
  // / Recent), scroll its row into view. Ancestor folders are expanded in the
  // store's openNote, so the row is rendered by the time this runs.
  useEffect(() => {
    if (active) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (ctx.renaming === note.path) {
    return <RenameInput path={note.path} kind="note" initial={note.title} depth={depth} />;
  }

  return (
    <div
      ref={rowRef}
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
        ctx.openMenu(e, { kind: "note", path: note.path, note });
      }}
      onClick={() => void openNote(note.path)}
      onMouseEnter={() => prefetchNote(note.path)}
      title={note.path}
      style={{ paddingLeft: 24 + depth * 12 }}
      className={`group relative flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm transition-colors ${
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
}

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
  const { endNewFolder } = useSidebarCtx();
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
  const { endRename } = useSidebarCtx();
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
