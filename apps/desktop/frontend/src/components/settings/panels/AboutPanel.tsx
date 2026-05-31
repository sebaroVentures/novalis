import { useEffect, useState } from "react";

import { useTranslation } from "react-i18next";

import { api, type AppInfo } from "../../../ipc/api";
import { SettingsSection } from "../../ui";

export function AboutPanel() {
  const { t } = useTranslation("settings");
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void api.appInfo().then(setInfo).catch(() => {});
  }, []);

  return (
    <SettingsSection title={t("about.section")}>
      <div className="space-y-1 text-sm text-fg-muted">
        <div className="flex justify-between border-b border-border/60 py-2">
          <span>{t("about.application")}</span>
          {/* eslint-disable-next-line i18next/no-literal-string -- product name fallback */}
          <span className="text-fg">{info?.name ?? "Novalis"}</span>
        </div>
        <div className="flex justify-between py-2">
          <span>{t("about.version")}</span>
          <span className="text-fg">{info?.version ?? "—"}</span>
        </div>
      </div>
      <p className="mt-4 text-xs text-fg-faint">{t("about.tagline")}</p>
    </SettingsSection>
  );
}
