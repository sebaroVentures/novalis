import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useSettings } from "../../../stores/settingsStore";
import { useTasks } from "../../../stores/taskStore";
import { SettingsSection } from "../../ui";
import { PanelLoading } from "./PanelLoading";

interface Col {
  id: string;
  title: string;
}

const DEFAULT_COLS: Col[] = [
  { id: "backlog", title: "Backlog" },
  { id: "todo", title: "To Do" },
  { id: "in-progress", title: "In Progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
];

export function TasksPanel() {
  const { t } = useTranslation("settings");
  const prefs = useSettings((s) => s.prefs);
  if (!prefs) return <PanelLoading />;

  const cols: Col[] = (prefs.taskView?.kanbanColumns ?? [])
    .map((c) => ({ id: c.id ?? "", title: c.title ?? "" }))
    .filter((c) => c.id !== "");
  const columns = cols.length > 0 ? cols : DEFAULT_COLS;
  const setColumns = (next: Col[]) => {
    useSettings.getState().setTaskView({ kanbanColumns: next });
    useTasks.getState().setColumnsFromPreferences(next);
  };

  return (
    <SettingsSection title={t("tasks.sectionColumns")} description={t("tasks.columnsDesc")}>
      <div className="space-y-1.5">
        {columns.map((col, i) => (
          <div key={col.id} className="flex items-center gap-2">
            <input
              value={col.title}
              onChange={(ev) =>
                setColumns(columns.map((x, idx) => (idx === i ? { ...x, title: ev.target.value } : x)))
              }
              className="flex-1 rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-fg outline-none ring-1 ring-transparent transition focus:ring-accent/50"
            />
            <button
              onClick={() => setColumns(columns.filter((_, idx) => idx !== i))}
              aria-label={t("tasks.removeColumn")}
              className="rounded-md p-1.5 text-fg-subtle transition-colors hover:bg-hover hover:text-danger"
            >
              <X size={15} />
            </button>
          </div>
        ))}
      </div>
      <button
        onClick={() => setColumns([...columns, { id: `col-${Date.now()}`, title: t("tasks.newColumn") }])}
        className="mt-2 flex items-center gap-1 text-xs font-medium text-accent transition-opacity hover:opacity-80"
      >
        <Plus size={13} /> {t("tasks.addColumn")}
      </button>
    </SettingsSection>
  );
}
