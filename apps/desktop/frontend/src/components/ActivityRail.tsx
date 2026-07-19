import { useEffect } from "react";

import {
  Calendar,
  FileText,
  Mic,
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

import { featureOn, useFeature } from "../lib/features";
import { ACTION_FEATURE, formatChord, type ActionId, type Chord } from "../lib/keybindings";
import { useRailConfig } from "../lib/railPrefs";
import { useKeymap } from "../stores/keymapStore";
import { useSettings } from "../stores/settingsStore";
import { useVoice } from "../stores/voiceStore";
import type { MainView } from "./Sidebar";

const railBtn =
  "flex h-9 w-9 items-center justify-center rounded-md transition-colors";
const railBtnIdle = "text-fg-muted hover:bg-hover hover:text-fg";

/** Per-view metadata: keymap action (for the live chord in the tooltip) and
 *  icon. Labels come from common:views.*. The rail's ORDER comes from the
 *  (device-local) rail config; which views show comes from the vault's feature
 *  flags (via ACTION_FEATURE). This map is keyed by view so the config can
 *  reference any subset in any order. */
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
  const { t } = useTranslation(["common", "sidebar", "trash", "ai"]);
  const keymap = useKeymap((s) => s.keymap);
  const railConfig = useRailConfig((s) => s.config);
  // Native meeting capture (W4.3): a dezent tool that only appears where capture
  // is supported (desktop). Recording state shows as a corner ping-badge so the
  // running capture stays visible even when the docked status strip is scrolled
  // out of view; clicking it while recording stops the take.
  const voiceAvailable = useVoice((s) => s.available);
  const voiceStatus = useVoice((s) => s.status);
  const voiceOn = useFeature("voice");
  // Which views exist comes from the vault's feature flags alone; the rail
  // config only contributes ORDER (its legacy `enabled` bit is ignored —
  // availability is managed in Settings › Features).
  const features = useSettings((s) => s.prefs?.features);
  const withChord = (label: string, chord?: Chord) =>
    chord ? `${label} (${formatChord(chord)})` : label;

  // If the active view's feature was just turned off (Settings › Features, or
  // a vault whose flags differ), fall back to the first available view so the
  // content pane never strands on a feature-off view. Keybindings and the
  // palette are gated on the same flags, so a hidden view is truly off.
  // `notes` is core (never gated), so the list can't be empty; the ?? guard
  // only satisfies the indexed-access type.
  useEffect(() => {
    const available = railConfig
      .filter((i) => {
        const feat = ACTION_FEATURE[VIEW_ITEMS[i.view].action];
        return !feat || featureOn(features, feat);
      })
      .map((i) => i.view);
    if (!available.includes(view)) onViewChange(available[0] ?? "notes");
  }, [railConfig, features, view, onViewChange]);
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
        .filter((i) => {
          const feat = ACTION_FEATURE[VIEW_ITEMS[i.view].action];
          return !feat || featureOn(features, feat);
        })
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
        {voiceAvailable && voiceOn && (
          <div className="relative">
            <button
              aria-label={voiceStatus === "recording" ? t("ai:voice.stop") : t("ai:voice.tooltip")}
              title={voiceStatus === "recording" ? t("ai:voice.stop") : t("ai:voice.tooltip")}
              disabled={voiceStatus === "transcribing"}
              onClick={() => {
                const v = useVoice.getState();
                if (voiceStatus === "recording") void v.stopAndProcess();
                else void v.start();
              }}
              className={`${railBtn} ${
                voiceStatus === "recording" ? "text-danger hover:bg-hover" : railBtnIdle
              } disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <Mic size={18} />
            </button>
            {voiceStatus === "recording" && (
              <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
              </span>
            )}
          </div>
        )}
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
