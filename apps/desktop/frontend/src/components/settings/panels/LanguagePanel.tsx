import { useState } from "react";

import { useTranslation } from "react-i18next";

import { applyLanguage } from "../../../lib/i18n";
import {
  getLanguage,
  languageDisplayName,
  setLanguage,
  SUPPORTED_LANGUAGES,
  type LanguageCode,
} from "../../../lib/language";
import { Select, SettingRow, SettingsSection } from "../../ui";

// The UI language is device-local (localStorage), not vault-scoped — so it
// applies immediately and persists per device rather than syncing with the
// vault. No settingsStore involvement; we drive lib/language.ts directly.
export function LanguagePanel() {
  const { t } = useTranslation("settings");
  const [lang, setLang] = useState<LanguageCode>(getLanguage());

  const change = (v: string) => {
    const code = v as LanguageCode;
    setLang(code);
    setLanguage(code);
    applyLanguage(code);
  };

  return (
    <SettingsSection title={t("language.section")}>
      <SettingRow
        label={t("language.label")}
        description={t("language.hint")}
        htmlFor="language-select"
        control={
          <Select
            id="language-select"
            value={lang}
            onChange={change}
            options={SUPPORTED_LANGUAGES.map((c) => ({
              value: c,
              label: languageDisplayName(c),
            }))}
          />
        }
      />
    </SettingsSection>
  );
}
