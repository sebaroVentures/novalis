import {
  Calendar,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  SquareCheckBig,
  Sun,
  Trash2,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatChord, type ActionId, type Chord } from "../lib/keybindings";
import { useKeymap } from "../stores/keymapStore";
import type { MainView } from "./Sidebar";

const railBtn =
  "flex h-9 w-9 items-center justify-center rounded-md transition-colors";
const railBtnIdle = "text-fg-muted hover:bg-hover hover:text-fg";

/** The five top-level views in rail order, each with its keymap action (for the
 *  live chord in the tooltip) and icon. Labels come from common:views.*. */
const VIEW_ITEMS: { view: MainView; action: ActionId; Icon: LucideIcon }[] = [
  { view: "notes", action: "view-notes", Icon: FileText },
  { view: "today", action: "view-today", Icon: Sun },
  { view: "tasks", action: "view-tasks", Icon: SquareCheckBig },
  { view: "calendar", action: "view-calendar", Icon: Calendar },
  { view: "graph", action: "view-graph", Icon: Waypoints },
];

/** Vertical activity rail (VS Code/Obsidian style): view switching on top,
 *  app-level tools (search / trash / settings / sidebar toggle) at the bottom.
 *  Replaces the sidebar's horizontal segmented control, whose five labels
 *  overflowed in wordier locales (e.g. German). */
export function ActivityRail({
  view,
  onViewChange,
  onOpenSearch,
  onOpenSettings,
  onOpenTrash,
  sidebarCollapsed,
  onToggleSidebar,
}: {
  view: MainView;
  onViewChange: (v: MainView) => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  onOpenTrash: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}) {
  const { t } = useTranslation(["common", "sidebar", "trash"]);
  const keymap = useKeymap((s) => s.keymap);
  const withChord = (label: string, chord?: Chord) =>
    chord ? `${label} (${formatChord(chord)})` : label;
  const viewLabels: Record<MainView, string> = {
    notes: t("views.notes"),
    today: t("views.today"),
    tasks: t("views.tasks"),
    calendar: t("views.calendar"),
    graph: t("views.graph"),
  };
  const toggleLabel = sidebarCollapsed ? t("showSidebar") : t("sidebar:collapseSidebar");

  return (
    <nav
      role="navigation"
      aria-label={t("mainNav")}
      className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-2"
    >
      {VIEW_ITEMS.map(({ view: v, action, Icon }) => (
        <button
          key={v}
          aria-label={viewLabels[v]}
          aria-current={view === v ? "page" : undefined}
          title={withChord(viewLabels[v], keymap[action])}
          onClick={() => onViewChange(v)}
          className={`${railBtn} ${view === v ? "bg-active text-fg" : railBtnIdle}`}
        >
          <Icon size={18} />
        </button>
      ))}

      <div className="mt-auto flex flex-col items-center gap-1">
        <button
          aria-label={t("sidebar:search")}
          title={withChord(t("sidebar:search"), keymap.search)}
          onClick={onOpenSearch}
          className={`${railBtn} ${railBtnIdle}`}
        >
          <Search size={18} />
        </button>
        <button
          aria-label={t("trash:title")}
          title={t("trash:title")}
          onClick={onOpenTrash}
          className={`${railBtn} ${railBtnIdle}`}
        >
          <Trash2 size={18} />
        </button>
        <button
          aria-label={t("sidebar:settings")}
          title={withChord(t("sidebar:settings"), keymap.settings)}
          onClick={onOpenSettings}
          className={`${railBtn} ${railBtnIdle}`}
        >
          <Settings size={18} />
        </button>
        <button
          aria-label={toggleLabel}
          title={withChord(toggleLabel, keymap["toggle-sidebar"])}
          onClick={onToggleSidebar}
          className={`${railBtn} ${railBtnIdle} hidden md:flex`}
        >
          {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </div>
    </nav>
  );
}
