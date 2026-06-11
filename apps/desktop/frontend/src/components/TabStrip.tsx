import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { noteTitleFromPath } from "../lib/taskDisplay";
import type { Pane } from "../lib/workspacePrefs";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";

/** Scrollable row of one pane's open note tabs. One live editor backs the
 *  active tab; the rest are inert {path} descriptors. Hidden when empty. */
export function TabStrip({ pane }: { pane: Pane }) {
  const { t } = useTranslation("editor");
  const setActiveTab = useUi((s) => s.setActiveTab);
  const closeTab = useUi((s) => s.closeTab);
  const paneFocused = useUi((s) => s.workspace.focusedPaneId === pane.id);

  if (pane.tabs.length === 0) return null;

  return (
    <div className="flex shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-border bg-surface px-1 pt-1">
      {pane.tabs.map((path) => (
        <TabItem
          key={path}
          path={path}
          active={path === pane.activeTab}
          paneFocused={paneFocused}
          onSelect={(p) => setActiveTab(p, pane.id)}
          onClose={(p) => void closeTab(p, pane.id)}
          closeLabel={t("closeTab")}
        />
      ))}
    </div>
  );
}

function TabItem({
  path,
  active,
  paneFocused,
  onSelect,
  onClose,
  closeLabel,
}: {
  path: string;
  active: boolean;
  paneFocused: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  closeLabel: string;
}) {
  const state = useVault((s) => s.saveStates.get(path) ?? "idle");
  // The active tab can show the live note's (frontmatter) title; background tabs
  // fall back to the basename (the app-wide path→label convention).
  const liveTitle = useVault((s) => (active ? (s.openNotes.get(path)?.title ?? null) : null));
  const label = liveTitle || noteTitleFromPath(path);
  const unsaved = state === "dirty" || state === "saving" || state === "error";

  return (
    <div
      role="tab"
      aria-selected={active}
      title={label}
      onClick={() => onSelect(path)}
      onAuxClick={(e) => {
        // Middle-click closes (browser-tab convention).
        if (e.button === 1) {
          e.preventDefault();
          onClose(path);
        }
      }}
      className={`group flex max-w-[12rem] min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border-b-2 px-3 py-1.5 text-xs transition-colors ${
        active
          ? // The focused pane's active tab carries the accent; an unfocused
            // pane's active tab is marked but muted, so the pane receiving
            // keyboard shortcuts is always identifiable.
            paneFocused
            ? "border-accent bg-surface-2 text-fg"
            : "border-border-strong bg-surface-2 text-fg-muted"
          : "border-transparent text-fg-muted hover:bg-hover"
      }`}
    >
      <span className="truncate">{label}</span>
      <span className="relative flex size-3.5 shrink-0 items-center justify-center">
        {unsaved && (
          <span
            className={`size-1.5 rounded-full group-hover:opacity-0 ${
              state === "error" ? "bg-danger" : "bg-accent"
            }`}
          />
        )}
        <button
          type="button"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={(e) => {
            e.stopPropagation();
            onClose(path);
          }}
          className="absolute inset-0 flex items-center justify-center rounded opacity-0 transition-opacity hover:bg-hover hover:text-fg group-hover:opacity-100"
        >
          <X size={12} />
        </button>
      </span>
    </div>
  );
}
