import {
  Calendar,
  ChevronDown,
  ChevronUp,
  FileText,
  Shapes,
  SquareCheckBig,
  Sun,
  Table2,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { featureOn } from "../../../lib/features";
import { ACTION_FEATURE } from "../../../lib/keybindings";
import { useRailConfig } from "../../../lib/railPrefs";
import { useSettings } from "../../../stores/settingsStore";
import type { MainView } from "../../Sidebar";
import { SettingsSection } from "../../ui";

/** Icon per view, keyed so the panel can list the config in any order. Mirrors
 *  ActivityRail's VIEW_ITEMS icons (enumerated for the type checker). */
const VIEW_ICONS: Record<MainView, LucideIcon> = {
  notes: FileText,
  today: Sun,
  tasks: SquareCheckBig,
  calendar: Calendar,
  graph: Waypoints,
  query: Table2,
  canvas: Shapes,
};

/** Order-only rail layout. WHICH views are available is owned by the vault's
 *  feature flags (Settings › Features) — this panel only reorders them, and
 *  hides rows whose feature is off (their stored position survives, so turning
 *  a feature back on restores the user's order). */
export function NavigationPanel() {
  const { t } = useTranslation(["settings", "common"]);
  const config = useRailConfig((s) => s.config);
  const move = useRailConfig((s) => s.move);
  const features = useSettings((s) => s.prefs?.features);

  const viewLabels: Record<MainView, string> = {
    notes: t("common:views.notes"),
    today: t("common:views.today"),
    tasks: t("common:views.tasks"),
    calendar: t("common:views.calendar"),
    graph: t("common:views.graph"),
    query: t("common:views.query"),
    canvas: t("common:views.canvas"),
  };
  const visible = config.filter((item) => {
    const feat = ACTION_FEATURE[`view-${item.view}`];
    return !feat || featureOn(features, feat);
  });

  return (
    <SettingsSection
      title={t("settings:navigation.sectionRail")}
      description={t("settings:navigation.railDesc")}
    >
      <ul className="space-y-1.5">
        {visible.map((item, i) => {
          const Icon = VIEW_ICONS[item.view];
          const label = viewLabels[item.view];
          return (
            <li
              key={item.view}
              className="flex items-center gap-2 rounded-lg bg-surface-2 px-2 py-1.5"
            >
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => move(item.view, -1)}
                  disabled={i === 0}
                  aria-label={t("settings:navigation.moveUp", { view: label })}
                  className="rounded p-0.5 text-fg-subtle transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => move(item.view, 1)}
                  disabled={i === visible.length - 1}
                  aria-label={t("settings:navigation.moveDown", { view: label })}
                  className="rounded p-0.5 text-fg-subtle transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronDown size={14} />
                </button>
              </div>
              <Icon size={16} className="shrink-0 text-fg-muted" />
              <span className="flex-1 text-sm text-fg">{label}</span>
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}
