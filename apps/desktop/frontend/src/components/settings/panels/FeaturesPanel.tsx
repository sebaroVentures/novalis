import type { ReactNode } from "react";

import { useTranslation } from "react-i18next";

import type { FeaturePrefs } from "../../../ipc/api";
import {
  resolveFeaturePrefs,
  resolveGitPrefs,
  useSettings,
} from "../../../stores/settingsStore";
import { SettingRow, SettingsSection, Switch } from "../../ui";
import { PanelLoading } from "./PanelLoading";

type FlagKey = keyof Required<FeaturePrefs>;

/** One feature toggle bound to Preferences.features. Labels arrive already
 *  translated so every t() call below stays a static literal. */
function FeatureRow({
  flag,
  checked,
  label,
  description,
  aria,
  disabled,
}: {
  flag: FlagKey;
  checked: boolean;
  label: string;
  description: string;
  aria: string;
  disabled?: boolean;
}) {
  return (
    <SettingRow
      label={label}
      description={description}
      control={
        <Switch
          checked={checked}
          disabled={disabled}
          onChange={(v) => useSettings.getState().setFeatures({ [flag]: v })}
          aria-label={aria}
        />
      }
    />
  );
}

/** Indents the AI sub-toggles under the master switch. */
function SubRows({ children }: { children: ReactNode }) {
  return <div className="ml-1 border-l border-border pl-4">{children}</div>;
}

export function FeaturesPanel() {
  const { t } = useTranslation("settings");
  const prefs = useSettings((s) => s.prefs);
  if (!prefs) return <PanelLoading />;

  const settings = useSettings.getState();
  const f = resolveFeaturePrefs(prefs.features);
  const git = resolveGitPrefs(prefs.git);

  return (
    <>
      <SettingsSection
        title={t("features.sectionAi")}
        description={t("features.sectionAiDesc")}
      >
        <FeatureRow
          flag="ai"
          checked={f.ai}
          label={t("features.ai.label")}
          description={t("features.ai.desc")}
          aria={t("features.ai.aria")}
        />
        <SubRows>
          {/* Ambient suggestions keep their canonical gate in
              EditorPrefs.ambientAi — this row is the same pref as
              Settings › AI, not a separate flag. */}
          <SettingRow
            label={t("features.ambient.label")}
            description={t("features.ambient.desc")}
            control={
              <Switch
                checked={prefs.editor?.ambientAi ?? false}
                disabled={!f.ai}
                onChange={(v) => settings.setEditor({ ambientAi: v })}
                aria-label={t("features.ambient.aria")}
              />
            }
          />
          <FeatureRow
            flag="aiMetaSuggestions"
            checked={f.aiMetaSuggestions}
            disabled={!f.ai}
            label={t("features.aiMetaSuggestions.label")}
            description={t("features.aiMetaSuggestions.desc")}
            aria={t("features.aiMetaSuggestions.aria")}
          />
          <FeatureRow
            flag="aiTemplates"
            checked={f.aiTemplates}
            disabled={!f.ai}
            label={t("features.aiTemplates.label")}
            description={t("features.aiTemplates.desc")}
            aria={t("features.aiTemplates.aria")}
          />
          <FeatureRow
            flag="taskExtract"
            checked={f.taskExtract}
            disabled={!f.ai}
            label={t("features.taskExtract.label")}
            description={t("features.taskExtract.desc")}
            aria={t("features.taskExtract.aria")}
          />
          <FeatureRow
            flag="weeklyReview"
            checked={f.weeklyReview}
            disabled={!f.ai}
            label={t("features.weeklyReview.label")}
            description={t("features.weeklyReview.desc")}
            aria={t("features.weeklyReview.aria")}
          />
          <FeatureRow
            flag="vaultChat"
            checked={f.vaultChat}
            disabled={!f.ai}
            label={t("features.vaultChat.label")}
            description={t("features.vaultChat.desc")}
            aria={t("features.vaultChat.aria")}
          />
          <FeatureRow
            flag="relatedNotes"
            checked={f.relatedNotes}
            disabled={!f.ai}
            label={t("features.relatedNotes.label")}
            description={t("features.relatedNotes.desc")}
            aria={t("features.relatedNotes.aria")}
          />
          <FeatureRow
            flag="entityGraph"
            checked={f.entityGraph}
            disabled={!f.ai}
            label={t("features.entityGraph.label")}
            description={t("features.entityGraph.desc")}
            aria={t("features.entityGraph.aria")}
          />
        </SubRows>
      </SettingsSection>

      <SettingsSection title={t("features.sectionEditor")}>
        <FeatureRow
          flag="blockRefs"
          checked={f.blockRefs}
          label={t("features.blockRefs.label")}
          description={t("features.blockRefs.desc")}
          aria={t("features.blockRefs.aria")}
        />
        <FeatureRow
          flag="transclusion"
          checked={f.transclusion}
          label={t("features.transclusion.label")}
          description={t("features.transclusion.desc")}
          aria={t("features.transclusion.aria")}
        />
        <FeatureRow
          flag="mermaid"
          checked={f.mermaid}
          label={t("features.mermaid.label")}
          description={t("features.mermaid.desc")}
          aria={t("features.mermaid.aria")}
        />
        <FeatureRow
          flag="math"
          checked={f.math}
          label={t("features.math.label")}
          description={t("features.math.desc")}
          aria={t("features.math.aria")}
        />
        <FeatureRow
          flag="codeHighlight"
          checked={f.codeHighlight}
          label={t("features.codeHighlight.label")}
          description={t("features.codeHighlight.desc")}
          aria={t("features.codeHighlight.aria")}
        />
        <FeatureRow
          flag="callouts"
          checked={f.callouts}
          label={t("features.callouts.label")}
          description={t("features.callouts.desc")}
          aria={t("features.callouts.aria")}
        />
        <FeatureRow
          flag="tagAutocomplete"
          checked={f.tagAutocomplete}
          label={t("features.tagAutocomplete.label")}
          description={t("features.tagAutocomplete.desc")}
          aria={t("features.tagAutocomplete.aria")}
        />
        <FeatureRow
          flag="outline"
          checked={f.outline}
          label={t("features.outline.label")}
          description={t("features.outline.desc")}
          aria={t("features.outline.aria")}
        />
      </SettingsSection>

      <SettingsSection
        title={t("features.sectionWorkspace")}
        description={t("features.sectionWorkspaceDesc")}
      >
        <FeatureRow
          flag="todayView"
          checked={f.todayView}
          label={t("features.todayView.label")}
          description={t("features.todayView.desc")}
          aria={t("features.todayView.aria")}
        />
        <FeatureRow
          flag="tasks"
          checked={f.tasks}
          label={t("features.tasks.label")}
          description={t("features.tasks.desc")}
          aria={t("features.tasks.aria")}
        />
        <FeatureRow
          flag="calendar"
          checked={f.calendar}
          label={t("features.calendar.label")}
          description={t("features.calendar.desc")}
          aria={t("features.calendar.aria")}
        />
      </SettingsSection>

      <SettingsSection title={t("features.sectionGraph")}>
        <FeatureRow
          flag="backlinks"
          checked={f.backlinks}
          label={t("features.backlinks.label")}
          description={t("features.backlinks.desc")}
          aria={t("features.backlinks.aria")}
        />
        <FeatureRow
          flag="graphView"
          checked={f.graphView}
          label={t("features.graphView.label")}
          description={t("features.graphView.desc")}
          aria={t("features.graphView.aria")}
        />
        <FeatureRow
          flag="properties"
          checked={f.properties}
          label={t("features.properties.label")}
          description={t("features.properties.desc")}
          aria={t("features.properties.aria")}
        />
      </SettingsSection>

      <SettingsSection title={t("features.sectionPower")}>
        <FeatureRow
          flag="queryEngine"
          checked={f.queryEngine}
          label={t("features.queryEngine.label")}
          description={t("features.queryEngine.desc")}
          aria={t("features.queryEngine.aria")}
        />
        <FeatureRow
          flag="dailyNotes"
          checked={f.dailyNotes}
          label={t("features.dailyNotes.label")}
          description={t("features.dailyNotes.desc")}
          aria={t("features.dailyNotes.aria")}
        />
        <FeatureRow
          flag="plugins"
          checked={f.plugins}
          label={t("features.plugins.label")}
          description={t("features.plugins.desc")}
          aria={t("features.plugins.aria")}
        />
        <FeatureRow
          flag="reminders"
          checked={f.reminders}
          label={t("features.reminders.label")}
          description={t("features.reminders.desc")}
          aria={t("features.reminders.aria")}
        />
      </SettingsSection>

      <SettingsSection title={t("features.sectionSync")}>
        {/* Git sync keeps its canonical gate in GitPrefs.enabled — this row is
            the same pref as Settings › Sync, not a separate flag. */}
        <SettingRow
          label={t("features.git.label")}
          description={t("features.git.desc")}
          control={
            <Switch
              checked={git.enabled}
              onChange={(v) => settings.setGit({ enabled: v })}
              aria-label={t("features.git.aria")}
            />
          }
        />
        <FeatureRow
          flag="p2pSync"
          checked={f.p2pSync}
          label={t("features.p2pSync.label")}
          description={t("features.p2pSync.desc")}
          aria={t("features.p2pSync.aria")}
        />
        <FeatureRow
          flag="calendarSync"
          checked={f.calendarSync}
          label={t("features.calendarSync.label")}
          description={t("features.calendarSync.desc")}
          aria={t("features.calendarSync.aria")}
        />
        <FeatureRow
          flag="icsSubscriptions"
          checked={f.icsSubscriptions}
          label={t("features.icsSubscriptions.label")}
          description={t("features.icsSubscriptions.desc")}
          aria={t("features.icsSubscriptions.aria")}
        />
      </SettingsSection>

      <SettingsSection title={t("features.sectionMedia")}>
        <FeatureRow
          flag="canvas"
          checked={f.canvas}
          label={t("features.canvas.label")}
          description={t("features.canvas.desc")}
          aria={t("features.canvas.aria")}
        />
        <FeatureRow
          flag="pdfAnnotate"
          checked={f.pdfAnnotate}
          label={t("features.pdfAnnotate.label")}
          description={t("features.pdfAnnotate.desc")}
          aria={t("features.pdfAnnotate.aria")}
        />
        <FeatureRow
          flag="voice"
          checked={f.voice}
          label={t("features.voice.label")}
          description={t("features.voice.desc")}
          aria={t("features.voice.aria")}
        />
      </SettingsSection>
    </>
  );
}
