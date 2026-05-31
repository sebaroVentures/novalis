import { useTranslation } from "react-i18next";

import { useSettings } from "../../../stores/settingsStore";
import { NumberField, SettingRow, SettingsSection, Switch } from "../../ui";
import { PanelLoading } from "./PanelLoading";

export function EditorPanel() {
  const { t } = useTranslation("settings");
  const prefs = useSettings((s) => s.prefs);
  if (!prefs) return <PanelLoading />;

  const settings = useSettings.getState();
  const e = prefs.editor ?? {};

  return (
    <>
      <SettingsSection title={t("editor.sectionEditing")}>
        <SettingRow
          label={t("editor.autosave.label")}
          description={t("editor.autosave.desc")}
          control={
            <NumberField
              value={e.autosaveMs ?? 600}
              min={200}
              max={5000}
              step={100}
              suffix="ms"
              onChange={(n) => settings.setEditor({ autosaveMs: n })}
            />
          }
        />
        <SettingRow
          label={t("editor.spellcheck.label")}
          description={t("editor.spellcheck.desc")}
          control={
            <Switch
              checked={e.spellcheck ?? true}
              onChange={(v) => settings.setEditor({ spellcheck: v })}
              aria-label={t("editor.spellcheck.aria")}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t("editor.sectionAdvanced")}>
        <SettingRow
          label={t("editor.typing.label")}
          description={t("editor.typing.desc")}
          control={
            <NumberField
              value={e.serializeMs ?? 200}
              min={50}
              max={1000}
              step={50}
              suffix="ms"
              onChange={(n) => settings.setEditor({ serializeMs: n })}
            />
          }
        />
      </SettingsSection>
    </>
  );
}
