import { useState } from "react";

import { useTranslation } from "react-i18next";

import type { AppearancePrefs } from "../../../ipc/api";
import { COLOR_HEX } from "../../../lib/colors";
import { useSettings } from "../../../stores/settingsStore";
import {
  ColorSwatchPicker,
  NumberField,
  SegmentedControl,
  SettingRow,
  SettingsSection,
} from "../../ui";
import { PanelLoading } from "./PanelLoading";

export function AppearancePanel() {
  const prefs = useSettings((s) => s.prefs);
  if (!prefs) return <PanelLoading />;
  // Render the body only once prefs exist so the font-size draft (useState)
  // seeds from the real saved value rather than a stale fallback.
  return <AppearancePanelBody a={prefs.appearance ?? {}} />;
}

function AppearancePanelBody({ a }: { a: Partial<AppearancePrefs> }) {
  const { t } = useTranslation("settings");
  const settings = useSettings.getState();

  // Font size is the global UI scale: applying it live would reflow this very
  // dialog (rem-sized) and slide the control out from under the pointer. So we
  // keep a local draft that only feeds the preview, and commit the global apply
  // on blur — every Settings close path blurs the focused field first
  // (SettingsModal.close), so the draft is always flushed.
  const [fontSize, setFontSize] = useState(a.fontSize ?? 16);
  const commitFontSize = () => {
    const cur = useSettings.getState().prefs?.appearance?.fontSize ?? 16;
    if (fontSize !== cur) settings.setAppearance({ fontSize });
  };

  return (
    <>
      <SettingsSection title={t("appearance.sectionTheme")}>
        <SettingRow
          label={t("appearance.colorTheme.label")}
          description={t("appearance.colorTheme.desc")}
          control={
            <SegmentedControl
              value={a.theme ?? "dark"}
              onChange={(v) => settings.setAppearance({ theme: v })}
              options={[
                { value: "dark", label: t("appearance.colorTheme.dark") },
                { value: "light", label: t("appearance.colorTheme.light") },
                { value: "system", label: t("appearance.colorTheme.system") },
              ]}
            />
          }
        />
        <SettingRow
          label={t("appearance.accent.label")}
          description={t("appearance.accent.desc")}
          control={
            <ColorSwatchPicker
              value={a.accent ?? "indigo"}
              onChange={(token) => settings.setAppearance({ accent: token })}
              colors={COLOR_HEX}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t("appearance.sectionDisplay")}>
        {/* Custom row (not SettingRow) so we can place a live preview under the
            label/control without moving the control above it. */}
        <div className="border-b border-border/60 py-3">
          <div className="flex items-start justify-between gap-6">
            <div className="min-w-0">
              <span className="block text-sm text-fg">{t("appearance.fontSize.label")}</span>
              <p className="mt-0.5 text-xs text-fg-subtle">{t("appearance.fontSize.desc")}</p>
            </div>
            <div className="shrink-0" onBlur={commitFontSize}>
              <NumberField
                value={fontSize}
                min={12}
                max={22}
                step={1}
                suffix="px"
                onChange={setFontSize}
              />
            </div>
          </div>
          <div
            className="mt-3 overflow-hidden rounded-lg bg-surface-2 px-3 py-2 leading-tight text-fg-muted"
            style={{ fontSize }}
          >
            {t("appearance.fontSize.preview")}
          </div>
        </div>
        <SettingRow
          label={t("appearance.density.label")}
          description={t("appearance.density.desc")}
          control={
            <SegmentedControl
              value={a.density ?? "comfortable"}
              onChange={(v) => settings.setAppearance({ density: v })}
              options={[
                { value: "comfortable", label: t("appearance.density.comfortable") },
                { value: "compact", label: t("appearance.density.compact") },
              ]}
            />
          }
        />
      </SettingsSection>
    </>
  );
}
