import { useEffect, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import { api } from "../ipc/api";
import { usePlugins, type PluginCommand } from "../stores/pluginStore";
import { useVault } from "../stores/vaultStore";

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation("vault");
  const [query, setQuery] = useState("");
  const pluginCommands = usePlugins((s) => s.commands);
  const inputRef = useRef<HTMLInputElement>(null);

  const builtins: PluginCommand[] = [
    {
      id: "builtin:new-note",
      title: t("cmdNewNote"),
      pluginId: "builtin",
      run: () => void useVault.getState().newNote(""),
    },
    {
      id: "builtin:reindex",
      title: t("cmdReindex"),
      pluginId: "builtin",
      run: () => void api.reindexVault(),
    },
  ];

  const all = [...builtins, ...pluginCommands];
  const filtered = query.trim()
    ? all.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
    : all;

  useEffect(() => {
    if (open) {
      setQuery("");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  if (!open) return null;

  const run = (c: PluginCommand) => {
    c.run();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-overlay pt-28"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("cmdPlaceholder")}
          className="w-full bg-transparent px-4 py-3 text-fg outline-none placeholder:text-fg-faint"
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && filtered[0]) run(filtered[0]);
          }}
        />
        <ul className="max-h-80 overflow-y-auto border-t border-border">
          {filtered.length === 0 && (
            <li className="px-4 py-3 text-sm text-fg-faint">{t("cmdEmpty")}</li>
          )}
          {filtered.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => run(c)}
                className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left hover:bg-hover"
              >
                <span className="text-sm text-fg">{c.title}</span>
                <span className="text-[10px] uppercase tracking-wide text-fg-faint">
                  {c.pluginId === "builtin" ? t("cmdCore") : c.pluginId}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
