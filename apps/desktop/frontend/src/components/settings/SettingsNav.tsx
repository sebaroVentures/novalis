import type { ComponentType } from "react";

import {
  CalendarDays,
  FileText,
  FolderOpen,
  GitBranch,
  Import,
  Info,
  KanbanSquare,
  Keyboard,
  Languages,
  PanelLeft,
  Palette,
  PenLine,
  Puzzle,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";

export type CategoryId =
  | "general"
  | "vault"
  | "sync"
  | "appearance"
  | "navigation"
  | "language"
  | "editor"
  | "tasks"
  | "calendar"
  | "keybindings"
  | "templates"
  | "import"
  | "plugins"
  | "ai"
  | "about";

type IconType = ComponentType<{ size?: number | string; className?: string }>;

export const CATEGORIES: { id: CategoryId; icon: IconType }[] = [
  { id: "general", icon: SlidersHorizontal },
  { id: "vault", icon: FolderOpen },
  { id: "sync", icon: GitBranch },
  { id: "appearance", icon: Palette },
  { id: "navigation", icon: PanelLeft },
  { id: "language", icon: Languages },
  { id: "editor", icon: PenLine },
  { id: "tasks", icon: KanbanSquare },
  { id: "calendar", icon: CalendarDays },
  { id: "keybindings", icon: Keyboard },
  { id: "templates", icon: FileText },
  { id: "import", icon: Import },
  { id: "plugins", icon: Puzzle },
  { id: "ai", icon: Sparkles },
  { id: "about", icon: Info },
];

/** Translated label for each settings category. Keys are enumerated (not built
 *  dynamically) so the extractor and the type checker both see every one. */
export function useCategoryLabels(): Record<CategoryId, string> {
  const { t } = useTranslation("settings");
  return {
    general: t("nav.general"),
    vault: t("nav.vault"),
    sync: t("nav.sync"),
    appearance: t("nav.appearance"),
    navigation: t("nav.navigation"),
    language: t("nav.language"),
    editor: t("nav.editor"),
    tasks: t("nav.tasks"),
    calendar: t("nav.calendar"),
    keybindings: t("nav.keybindings"),
    templates: t("nav.templates"),
    import: t("nav.import"),
    plugins: t("nav.plugins"),
    ai: t("nav.ai"),
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
