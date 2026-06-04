import type { ComponentType } from "react";

import {
  CalendarDays,
  FileText,
  Info,
  KanbanSquare,
  Keyboard,
  Languages,
  Palette,
  PenLine,
  Puzzle,
  SlidersHorizontal,
} from "lucide-react";
import { useTranslation } from "react-i18next";

export type CategoryId =
  | "general"
  | "appearance"
  | "language"
  | "editor"
  | "tasks"
  | "calendar"
  | "keybindings"
  | "templates"
  | "plugins"
  | "about";

type IconType = ComponentType<{ size?: number | string; className?: string }>;

export const CATEGORIES: { id: CategoryId; icon: IconType }[] = [
  { id: "general", icon: SlidersHorizontal },
  { id: "appearance", icon: Palette },
  { id: "language", icon: Languages },
  { id: "editor", icon: PenLine },
  { id: "tasks", icon: KanbanSquare },
  { id: "calendar", icon: CalendarDays },
  { id: "keybindings", icon: Keyboard },
  { id: "templates", icon: FileText },
  { id: "plugins", icon: Puzzle },
  { id: "about", icon: Info },
];

/** Translated label for each settings category. Keys are enumerated (not built
 *  dynamically) so the extractor and the type checker both see every one. */
export function useCategoryLabels(): Record<CategoryId, string> {
  const { t } = useTranslation("settings");
  return {
    general: t("nav.general"),
    appearance: t("nav.appearance"),
    language: t("nav.language"),
    editor: t("nav.editor"),
    tasks: t("nav.tasks"),
    calendar: t("nav.calendar"),
    keybindings: t("nav.keybindings"),
    templates: t("nav.templates"),
    plugins: t("nav.plugins"),
    about: t("nav.about"),
  };
}

export function SettingsNav({
  active,
  onSelect,
}: {
  active: CategoryId;
  onSelect: (id: CategoryId) => void;
}) {
  const { t } = useTranslation("settings");
  const labels = useCategoryLabels();
  return (
    <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-app/40 p-2">
      <div className="px-2.5 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-fg-faint">
        {t("nav.heading")}
      </div>
      {CATEGORIES.map((c) => {
        const Icon = c.icon;
        const isActive = c.id === active;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.id)}
            className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
              isActive ? "bg-accent-soft text-accent" : "text-fg-muted hover:bg-hover hover:text-fg"
            }`}
          >
            <Icon size={16} className="shrink-0" />
            <span className="truncate">{labels[c.id]}</span>
          </button>
        );
      })}
    </nav>
  );
}
