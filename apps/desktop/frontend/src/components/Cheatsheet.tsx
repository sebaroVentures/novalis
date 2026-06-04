import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ACTION_IDS, formatChord } from "../lib/keybindings";
import { useKeymap } from "../stores/keymapStore";
import { useActionLabels } from "./settings/panels/KeybindingsPanel";

/** Read-only keyboard-shortcut reference (bound to the `cheatsheet` action). */
export function Cheatsheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation("settings");
  const keymap = useKeymap((s) => s.keymap);
  const labels = useActionLabels();

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("keybindings.title")}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-fg">{t("keybindings.title")}</h2>
          <button
            onClick={onClose}
            aria-label={t("modal.close")}
            className="rounded-md p-1 text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>
        <ul className="space-y-1.5">
          {ACTION_IDS.map((a) => (
            <li key={a} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-fg-muted">{labels[a]}</span>
              <kbd className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-fg ring-1 ring-border">
                {formatChord(keymap[a])}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
