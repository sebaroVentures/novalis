import { useState } from "react";

import { useTranslation } from "react-i18next";

import { getRecentLimit, setRecentLimit } from "../../../lib/sidebarPrefs";
import { useSettings } from "../../../stores/settingsStore";
import { toTaskMode, useTasks } from "../../../stores/taskStore";
import {
  NumberField,
  SegmentedControl,
  Select,
  SettingRow,
  SettingsSection,
  TextField,
} from "../../ui";
import { PanelLoading } from "./PanelLoading";

export function GeneralPanel() {
  const { t } = useTranslation(["settings", "common"]);
  const prefs = useSettings((s) => s.prefs);
  const [recentLimit, setRecentLimitState] = useState(getRecentLimit());
  if (!prefs) return <PanelLoading />;

  const settings = useSettings.getState();
  const tc = prefs.taskView?.taskCreation ?? { strategy: "inbox", inboxPath: "_Inbox.md" };
  const defaultMode = toTaskMode(prefs.taskView?.defaultMode) ?? "list";
  const startView = prefs.general?.defaultAppView ?? "notes";

  return (
    <>
      <SettingsSection title={t("general.startup.title")}>
        <SettingRow
          label={t("general.startView.label")}
          description={t("general.startView.desc")}
          control={
            <SegmentedControl
              value={startView}
              onChange={(v) => settings.setGeneral({ defaultAppView: v })}
              options={[
                { value: "notes", label: t("common:views.notes") },
                { value: "today", label: t("common:views.today") },
                { value: "tasks", label: t("common:views.tasks") },
                { value: "calendar", label: t("common:views.calendar") },
              ]}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t("general.taskCreation.title")}>
        <SettingRow
          label={t("general.strategy.label")}
          description={t("general.strategy.desc")}
          control={
            <Select
              value={tc.strategy ?? "inbox"}
              onChange={(v) => settings.setTaskView({ taskCreation: { ...tc, strategy: v } })}
              options={[
                { value: "inbox", label: t("general.strategy.inbox") },
                { value: "daily", label: t("general.strategy.daily") },
                { value: "active-note", label: t("general.strategy.activeNote") },
              ]}
            />
          }
        />
        <SettingRow
          label={t("general.inboxPath.label")}
          description={t("general.inboxPath.desc")}
          control={
            <TextField
              value={tc.inboxPath ?? "_Inbox.md"}
              onChange={(e) =>
                settings.setTaskView({ taskCreation: { ...tc, inboxPath: e.target.value } })
              }
              className="w-48"
            />
          }
        />
        <SettingRow
          label={t("general.defaultTaskView.label")}
          description={t("general.defaultTaskView.desc")}
          control={
            <SegmentedControl
              value={defaultMode}
              onChange={(v) => {
                settings.setTaskView({ defaultMode: v });
                useTasks.getState().applyDefaultMode(v);
              }}
              options={[
                { value: "kanban", label: t("common:taskModes.kanban") },
                { value: "list", label: t("common:taskModes.list") },
              ]}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t("general.sidebar.title")}>
        <SettingRow
          label={t("general.recentNotes.label")}
          description={t("general.recentNotes.desc")}
          control={
            <NumberField
              value={recentLimit}
              min={5}
              max={50}
              step={1}
              onChange={(n) => {
                setRecentLimitState(n);
                setRecentLimit(n);
              }}
            />
          }
        />
      </SettingsSection>
    </>
  );
}
