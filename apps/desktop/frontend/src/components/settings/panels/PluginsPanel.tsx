import { useEffect, useState } from "react";

import { Trans, useTranslation } from "react-i18next";

import { api, type PluginInfo } from "../../../ipc/api";
import { usePlugins } from "../../../stores/pluginStore";
import { SettingsSection, Switch } from "../../ui";

export function PluginsPanel() {
  const { t } = useTranslation("settings");
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);

  const reload = () => void api.listPlugins().then(setPlugins).catch(() => {});
  useEffect(() => {
    reload();
  }, []);

  const toggle = async (id: string, enabled: boolean) => {
    try {
      await api.setPluginEnabled(id, enabled);
      await usePlugins.getState().reload();
      setPlugins(await api.listPlugins());
    } catch {
      /* ignore */
    }
  };

  return (
    <SettingsSection title={t("plugins.section")}>
      {plugins.length === 0 ? (
        <p className="text-xs text-fg-faint">
          <Trans i18nKey="plugins.empty" ns="settings">
            No plugins installed. Drop a plugin folder into{" "}
            <code className="rounded bg-surface-2 px-1 py-0.5">.novalis/plugins/</code> in your vault
            (see PLUGINS.md), then reopen Settings.
          </Trans>
        </p>
      ) : (
        <div className="space-y-3">
          {plugins.map((p) => (
            <div key={p.manifest.id} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm text-fg">{p.manifest.name}</div>
                <div className="truncate text-xs text-fg-subtle">
                  {p.manifest.description || p.manifest.id}
                  {(p.manifest.capabilities ?? []).length > 0 &&
                    ` · ${(p.manifest.capabilities ?? []).join(", ")}`}
                </div>
              </div>
              <Switch
                checked={p.enabled}
                onChange={(v) => void toggle(p.manifest.id, v)}
                aria-label={t("plugins.enableAria", { name: p.manifest.name })}
              />
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
