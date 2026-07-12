import { useState } from "react";

import { useTranslation } from "react-i18next";

import {
  ACTION_IDS,
  type ActionId,
  chordFromEvent,
  formatChord,
  normalizeChord,
} from "../../../lib/keybindings";
import { useKeymap } from "../../../stores/keymapStore";
import { SettingRow, SettingsSection } from "../../ui";

/** Human labels for each action, shared by the panel and the cheatsheet.
 *  Reuses existing view/new-note strings; the rest live under settings:keybindings. */
export function useActionLabels(): Record<ActionId, string> {
  const { t } = useTranslation(["settings", "common", "vault"]);
  return {
    search: t("settings:keybindings.search"),
    "command-palette": t("settings:keybindings.commandPalette"),
    settings: t("settings:keybindings.settings"),
    "new-note": t("vault:cmdNewNote"),
    "view-notes": t("common:views.notes"),
    "view-today": t("common:views.today"),
    "view-tasks": t("common:views.tasks"),
    "view-calendar": t("common:views.calendar"),
    "view-graph": t("common:views.graph"),
    "view-query": t("common:views.query"),
    "view-canvas": t("common:views.canvas"),
    "nav-back": t("settings:keybindings.navBack"),
    "nav-forward": t("settings:keybindings.navForward"),
    cheatsheet: t("settings:keybindings.cheatsheet"),
    "toggle-sidebar": t("settings:keybindings.toggleSidebar"),
    "close-tab": t("settings:keybindings.closeTab"),
    "next-tab": t("settings:keybindings.nextTab"),
    "prev-tab": t("settings:keybindings.prevTab"),
    "split-right": t("settings:keybindings.splitRight"),
    "split-down": t("settings:keybindings.splitDown"),
    "focus-pane-left": t("settings:keybindings.focusPaneLeft"),
    "focus-pane-right": t("settings:keybindings.focusPaneRight"),
  };
}

export function KeybindingsPanel() {
  const { t } = useTranslation("settings");
  const keymap = useKeymap((s) => s.keymap);
  const rebind = useKeymap((s) => s.rebind);
  const reset = useKeymap((s) => s.reset);
  const labels = useActionLabels();
  const [capturing, setCapturing] = useState<ActionId | null>(null);

  // Count chord usage so duplicates can be flagged as conflicts.
  const counts = new Map<string, number>();
  for (const a of ACTION_IDS) counts.set(keymap[a], (counts.get(keymap[a]) ?? 0) + 1);

  const onCapture = (action: ActionId, e: React.KeyboardEvent) => {
    e.preventDefault();
    if (e.key === "Escape") {
      setCapturing(null);
      return;
    }
    // Wait for a real key, not a lone modifier.
    if (["Control", "Meta", "Shift", "Alt"].includes(e.key)) return;
    rebind(action, normalizeChord(chordFromEvent(e)));
    setCapturing(null);
  };

  return (
    <SettingsSection title={t("keybindings.title")}>
      {ACTION_IDS.map((a) => (
        <SettingRow
          key={a}
          label={labels[a]}
          control={
            capturing === a ? (
              <input
                autoFocus
                readOnly
                value={t("keybindings.pressKeys")}
                onKeyDown={(e) => onCapture(a, e)}
                onBlur={() => setCapturing(null)}
                className="w-40 rounded-md bg-surface-2 px-2 py-1 text-center text-xs text-fg outline-none ring-1 ring-accent"
              />
            ) : (
              <button
                onClick={() => setCapturing(a)}
                className={`min-w-20 rounded-md px-2 py-1 text-xs ring-1 transition-colors hover:bg-hover ${
                  (counts.get(keymap[a]) ?? 0) > 1
                    ? "text-danger ring-danger/50"
                    : "text-fg ring-border"
                }`}
              >
                {formatChord(keymap[a])}
              </button>
            )
          }
        />
      ))}
      <div className="pt-2">
        <button
          onClick={() => reset()}
          className="rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          {t("keybindings.reset")}
        </button>
      </div>
    </SettingsSection>
  );
}
