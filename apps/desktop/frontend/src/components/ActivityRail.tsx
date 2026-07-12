import { useEffect } from "react";

import {
  Calendar,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Shapes,
  SquareCheckBig,
  Sun,
  Table2,
  Trash2,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatChord, type ActionId, type Chord } from "../lib/keybindings";
import { useRailConfig } from "../lib/railPrefs";
import { useKeymap } from "../stores/keymapStore";
import type { MainView } from "./Sidebar";

const railBtn =
  "flex h-9 w-9 items-center justify-center rounded-md transition-colors";
const railBtnIdle = "text-fg-muted hover:bg-hover hover:text-fg";

/** Per-view metadata: keymap action (for the live chord in the tooltip) and
 *  icon. Labels come from common:views.*. The rail's ORDER and which views show
 *  come from the (device-local) rail config; this map is keyed by view so the
 *  config can reference any subset in any order. */
const VIEW_ITEMS: Record<MainView, { action: ActionId; Icon: LucideIcon }> = {
  notes: { action: "view-notes", Icon: FileText },
  today: { action: "view-today", Icon: Sun },
  tasks: { action: "view-tasks", Icon: SquareCheckBig },
  calendar: { action: "view-calendar", Icon: Calendar },
  graph: { action: "view-graph", Icon: Waypoints },
  query: { action: "view-query", Icon: Table2 },
  canvas: { action: "view-canvas", Icon: Shapes },
};

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
  const railConfig = useRailConfig((s) => s.config);
  const withChord = (label: string, chord?: Chord) =>
    chord ? `${label} (${formatChord(chord)})` : label;

  // If the active view was just hidden from the rail (disabled in Settings),
  // fall back to the first enabled view so the content pane never strands on a
  // view with no rail button. The view stays reachable via its keybinding, so
  // this is only about keeping the visible highlight/content in sync.
  useEffect(() => {
    const enabled = railConfig.filter((i) => i.enabled).map((i) => i.view);
    if (!enabled.includes(view)) onViewChange(enabled[0]);
  }, [railConfig, view, onViewChange]);
  const viewLabels: Record<MainView, string> = {
    notes: t("views.notes"),
    today: t("views.today"),
    tasks: t("views.tasks"),
    calendar: t("views.calendar"),
    graph: t("views.graph"),
    query: t("views.query"),
    canvas: t("views.canvas"),
  };
  const toggleLabel = sidebarCollapsed ? t("showSidebar") : t("sidebar:collapseSidebar");

  return (
    <nav
      role="navigation"
      aria-label={t("mainNav")}
      className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-2"
    >
      {railConfig
        .filter((i) => i.enabled)
        .map(({ view: v }) => {
          const { action, Icon } = VIEW_ITEMS[v];
          return (
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
          );
        })}

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
