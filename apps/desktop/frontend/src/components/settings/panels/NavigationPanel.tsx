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

import { useRailConfig } from "../../../lib/railPrefs";
import type { MainView } from "../../Sidebar";
import { Switch } from "../../ui";
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

export function NavigationPanel() {
  const { t } = useTranslation(["settings", "common"]);
  const config = useRailConfig((s) => s.config);
  const toggle = useRailConfig((s) => s.toggle);
  const move = useRailConfig((s) => s.move);

  const viewLabels: Record<MainView, string> = {
    notes: t("common:views.notes"),
    today: t("common:views.today"),
    tasks: t("common:views.tasks"),
    calendar: t("common:views.calendar"),
    graph: t("common:views.graph"),
    query: t("common:views.query"),
    canvas: t("common:views.canvas"),
  };
  const enabledCount = config.filter((i) => i.enabled).length;

  return (
    <SettingsSection
      title={t("settings:navigation.sectionRail")}
      description={t("settings:navigation.railDesc")}
    >
      <ul className="space-y-1.5">
        {config.map((item, i) => {
          const Icon = VIEW_ICONS[item.view];
          const label = viewLabels[item.view];
          // The last enabled view can't be turned off — an empty rail is a dead end.
          const lockOn = item.enabled && enabledCount === 1;
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
                  disabled={i === config.length - 1}
                  aria-label={t("settings:navigation.moveDown", { view: label })}
                  className="rounded p-0.5 text-fg-subtle transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronDown size={14} />
                </button>
              </div>
              <Icon size={16} className="shrink-0 text-fg-muted" />
              <span className="flex-1 text-sm text-fg">{label}</span>
              <Switch
                checked={item.enabled}
                disabled={lockOn}
                onChange={() => toggle(item.view)}
                aria-label={t("settings:navigation.toggleAria", { view: label })}
              />
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
}
