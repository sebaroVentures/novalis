import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { Menu, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ActivityRail } from "./components/ActivityRail";
import { AiActionPanel } from "./components/ai/AiActionPanel";
import { TaskExtractReview } from "./components/ai/TaskExtractReview";
import { WeeklyReviewCard } from "./components/ai/WeeklyReviewCard";
import { CalendarView } from "./components/CalendarView";
import { Cheatsheet } from "./components/Cheatsheet";
import { CloudHint } from "./components/CloudHint";
import { CommandPalette } from "./components/CommandPalette";
import { ConflictModal } from "./components/ConflictModal";
import { MergeConflictModal } from "./components/MergeConflictModal";
import { Onboarding } from "./components/Onboarding";
import { SearchModal } from "./components/SearchModal";
import { SettingsModal } from "./components/settings/SettingsModal";
import { Sidebar, type MainView } from "./components/Sidebar";
import { TasksView } from "./components/TasksView";
import { TodayView } from "./components/TodayView";
import { TrashModal } from "./components/TrashModal";
import { VaultChatPanel } from "./components/VaultChatPanel";
import { VaultGate } from "./components/VaultGate";
import { WorkspaceLayout } from "./components/WorkspaceLayout";

// Lazy: the Graph view pulls in d3-force, which stays out of the main bundle
// (the vite manualChunks rule keeps it in its own `d3-force` chunk).
const GraphView = lazy(() => import("./components/GraphView"));
import { applyAppearance, watchSystemTheme } from "./lib/appearance";
import { applyLanguage } from "./lib/i18n";
import { actionForEvent } from "./lib/keybindings";
import { getLanguage } from "./lib/language";
import {
  getSidebarWidth,
  loadSidebarCollapsed,
  saveSidebarCollapsed,
  saveSidebarWidth,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "./lib/uiPrefs";
import { checkReminders, resetReminderBaseline } from "./lib/reminderScheduler";
import { useAiEvents } from "./lib/useAiEvents";
import { useNovalisEvents } from "./lib/useNovalisEvents";
import { useConflicts } from "./stores/conflictStore";
import { useKeymap } from "./stores/keymapStore";
import { usePlugins } from "./stores/pluginStore";
import { useSettings } from "./stores/settingsStore";
import { useUi } from "./stores/uiStore";
import { useVault } from "./stores/vaultStore";

/** Cycle the focused pane's active tab by `dir` (wrapping). No-op below 2 tabs. */
function cycleTab(dir: 1 | -1): void {
  const ui = useUi.getState();
  if (ui.view !== "notes") return;
  const ws = ui.workspace;
  const pane = ws.panes.find((p) => p.id === ws.focusedPaneId);
  if (!pane || pane.tabs.length < 2 || !pane.activeTab) return;
  const i = pane.tabs.indexOf(pane.activeTab);
  ui.setActiveTab(pane.tabs[(i + dir + pane.tabs.length) % pane.tabs.length]);
}

export default function App() {
  const loading = useVault((s) => s.loading);
  const vaultPath = useVault((s) => s.vaultPath);
  const activePath = useVault((s) => s.activePath);
  const error = useVault((s) => s.error);
  const clearError = useVault((s) => s.clearError);
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);
  const [sidebarWidth, setSidebarWidth] = useState(getSidebarWidth);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const conflicts = useConflicts((s) => s.conflicts);
  const [notice, setNotice] = useState<string | null>(null);
  const onboardingDone = useUi((s) => s.onboardingDone);
  const initialViewVault = useRef<string | null>(null);
  const { t } = useTranslation(["common", "conflict"]);

  useNovalisEvents();
  useAiEvents();

  useEffect(() => {
    // UI language is device-local; apply it once at startup (before any vault),
    // so the document lang/dir is set and the VaultGate renders translated.
    applyLanguage(getLanguage());
    void useVault.getState().sync();
    usePlugins.getState().setNotify((m) => {
      setNotice(m);
      window.setTimeout(() => setNotice(null), 4000);
    });
  }, []);

  // (Re)load plugins whenever a vault becomes active.
  useEffect(() => {
    if (vaultPath) void usePlugins.getState().reload();
  }, [vaultPath]);

  // Restore this vault's editor tabs (and reopen its active tab) when it becomes
  // active; openVault clears the in-memory workspace first, so no stale tabs.
  useEffect(() => {
    if (vaultPath) useUi.getState().loadWorkspace(vaultPath);
  }, [vaultPath]);

  // Load preferences when a vault becomes active; apply appearance (theme /
  // accent / font-size / density) and, on first load, the configured start view.
  useEffect(() => {
    if (!vaultPath) {
      initialViewVault.current = null;
      return;
    }
    void useSettings
      .getState()
      .load()
      .then(() => {
        const prefs = useSettings.getState().prefs;
        applyAppearance(prefs?.appearance);
        if (initialViewVault.current !== vaultPath) {
          const dv = prefs?.general?.defaultAppView;
          if (dv === "notes" || dv === "today" || dv === "tasks" || dv === "calendar")
            useUi.getState().setView(dv);
          initialViewVault.current = vaultPath;
        }
      });
  }, [vaultPath]);

  // Re-apply theme when the OS color scheme changes (only matters for "system").
  useEffect(() => watchSystemTheme(() => useSettings.getState().prefs?.appearance), []);

  // Poll for task reminders while a vault is open (in-app toast + best-effort OS
  // notification). Past-due reminders aren't fired retroactively on open.
  useEffect(() => {
    if (!vaultPath) return;
    resetReminderBaseline();
    const id = window.setInterval(() => void checkReminders(), 30_000);
    return () => window.clearInterval(id);
  }, [vaultPath]);

  // Close the mobile nav drawer after navigating.
  useEffect(() => {
    setNavOpen(false);
  }, [view, activePath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // actionForEvent ignores modifier-less keystrokes, so ordinary typing
      // (including in the editor/inputs) is never intercepted.
      const action = actionForEvent(useKeymap.getState().keymap, e);
      if (!action) return;
      const handlers: Partial<Record<typeof action, () => void>> = {
        search: () => setSearchOpen((v) => !v),
        "command-palette": () => setPaletteOpen((v) => !v),
        settings: () => setSettingsOpen((v) => !v),
        "view-notes": () => useUi.getState().setView("notes"),
        "view-today": () => useUi.getState().setView("today"),
        "view-tasks": () => useUi.getState().setView("tasks"),
        "view-calendar": () => useUi.getState().setView("calendar"),
        "view-graph": () => useUi.getState().setView("graph"),
        "new-note": () =>
          void useVault.getState().newNote(useVault.getState().selectedFolder ?? ""),
        cheatsheet: () => setCheatsheetOpen((v) => !v),
        "nav-back": () => void useVault.getState().navBack(),
        "nav-forward": () => void useVault.getState().navForward(),
        "close-tab": () => {
          if (useUi.getState().view !== "notes") return;
          const ap = useVault.getState().activePath;
          if (ap) useUi.getState().closeTab(ap);
        },
        "next-tab": () => cycleTab(1),
        "prev-tab": () => cycleTab(-1),
        "split-right": () => {
          const ui = useUi.getState();
          if (ui.view === "notes") void ui.splitPane(ui.workspace.focusedPaneId, "row");
        },
        "split-down": () => {
          const ui = useUi.getState();
          if (ui.view === "notes") void ui.splitPane(ui.workspace.focusedPaneId, "column");
        },
        "focus-pane-left": () => {
          if (useUi.getState().view === "notes") useUi.getState().movePaneFocus(-1);
        },
        "focus-pane-right": () => {
          if (useUi.getState().view === "notes") useUi.getState().movePaneFocus(1);
        },
        "toggle-sidebar": () =>
          setSidebarCollapsed((v) => {
            const n = !v;
            saveSidebarCollapsed(n);
            return n;
          }),
      };
      const handler = handlers[action];
      if (handler) {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Persist any pending autosave before the window closes, so the last edits
  // aren't lost if the user quits within the debounce window.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const win = getCurrentWindow();
    void win
      .onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await Promise.race([
            useVault.getState().flushActive(),
            new Promise((r) => window.setTimeout(r, 2000)),
          ]);
        } catch {
          /* best-effort */
        }
        // preventDefault above swallowed the close — if destroy is rejected
        // (e.g. a missing `core:window:allow-destroy` capability), the window
        // becomes unclosable. Fail loud instead of silent.
        win.destroy().catch((e: unknown) => {
          console.error("window destroy failed — close is blocked:", e);
        });
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-app text-fg-subtle">
        {t("loading")}
      </main>
    );
  }

  if (!vaultPath) return <VaultGate />;

  const viewLabels: Record<MainView, string> = {
    notes: t("views.notes"),
    today: t("views.today"),
    tasks: t("views.tasks"),
    calendar: t("views.calendar"),
    graph: t("views.graph"),
  };

  return (
    <div className="nv-safe-shell flex h-screen w-screen overflow-hidden bg-app text-fg">
      {/* Left chrome: activity rail + content sidebar. Static from md up (the
          rail stays visible even with the sidebar collapsed — it carries view
          navigation and the reopen toggle); below md both slide in together as
          one drawer, so the rail never eats phone width when closed. */}
      <div
        className={`nv-safe-top nv-safe-shell fixed inset-y-0 left-0 z-40 flex transition-transform md:static md:z-auto md:translate-x-0 ${
          navOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <ActivityRail
          view={view}
          onViewChange={setView}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenTrash={() => setTrashOpen(true)}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() =>
            setSidebarCollapsed((v) => {
              const n = !v;
              saveSidebarCollapsed(n);
              return n;
            })
          }
        />
        {/* Collapsed hides the content sidebar on desktop only; the mobile
            drawer always shows it (the rail alone is no drawer). */}
        <div className={sidebarCollapsed ? "md:hidden" : ""}>
          <Sidebar onOpenSettings={() => setSettingsOpen(true)} width={sidebarWidth} />
        </div>
      </div>
      {/* Draggable width divider (desktop only; hidden when collapsed). */}
      {!sidebarCollapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = sidebarWidth;
            let latest = startW;
            document.body.style.userSelect = "none";
            const onMove = (ev: PointerEvent) => {
              latest = Math.max(
                SIDEBAR_MIN_WIDTH,
                Math.min(SIDEBAR_MAX_WIDTH, startW + (ev.clientX - startX)),
              );
              setSidebarWidth(latest);
            };
            const onUp = () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", onUp);
              document.body.style.userSelect = "";
              saveSidebarWidth(latest);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
          }}
          className="hidden w-1 shrink-0 cursor-col-resize transition-colors hover:bg-accent/40 md:block"
        />
      )}
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-overlay md:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile topbar: hamburger for the rail+sidebar drawer. On md+ the
            always-visible rail carries navigation and the reopen toggle, so no
            desktop bar is needed even when the sidebar is collapsed. */}
        <div className="nv-safe-top flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
          <button
            onClick={() => setNavOpen(true)}
            title={t("menu")}
            className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-active"
          >
            <Menu size={18} />
          </button>
          <span className="text-sm font-medium capitalize text-fg-muted">{viewLabels[view]}</span>
        </div>
        <CloudHint />
        {conflicts.length > 0 && (
          <button
            onClick={() => setConflictsOpen(true)}
            className="flex items-center justify-between gap-3 border-b border-border bg-surface-2 px-4 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-hover"
          >
            <span>{t("conflict:banner", { n: conflicts.length })}</span>
            <span className="shrink-0 font-medium text-accent">{t("conflict:review")}</span>
          </button>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          {view === "notes" ? (
            <WorkspaceLayout />
          ) : view === "today" ? (
            <TodayView />
          ) : view === "tasks" ? (
            <TasksView />
          ) : view === "graph" ? (
            <Suspense
              fallback={
                <div className="flex flex-1 items-center justify-center text-sm text-fg-faint">
                  {t("loading")}
                </div>
              }
            >
              <GraphView />
            </Suspense>
          ) : (
            <CalendarView />
          )}
        </div>
      </div>

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ConflictModal open={conflictsOpen} onClose={() => setConflictsOpen(false)} />
      {/* Git merge conflicts (sync P3a) — store-driven open, sibling of the
          OneDrive ConflictModal above. Mounted after SettingsModal so it
          stacks above the settings dialog that triggered the sync. */}
      <MergeConflictModal />
      <TrashModal open={trashOpen} onClose={() => setTrashOpen(false)} />
      <Cheatsheet open={cheatsheetOpen} onClose={() => setCheatsheetOpen(false)} />
      {/* First-run welcome — only reachable here (a vault is open); shows once
          per device, gated on the persisted onboardingDone flag. */}
      {!onboardingDone && <Onboarding />}
      <AiActionPanel />
      {/* Chat with your vault — store-driven right-docked panel; opened from the
          command palette / activity rail. Hybrid retrieval + cited streamed answer. */}
      <VaultChatPanel />
      {/* Meeting-note → task extraction review — store-driven open (sibling of
          MergeConflictModal above), opened from the editor AI menu / palette. */}
      <TaskExtractReview />
      {/* AI weekly review — narrative + carry-over proposals over the current
          week's deterministic digest, opened from the command palette. */}
      <WeeklyReviewCard />
      {notice && (
        <div className="fixed bottom-4 left-4 z-50 max-w-sm rounded-xl border border-border-strong/80 bg-surface/90 px-4 py-2.5 text-sm text-fg shadow-xl backdrop-blur">
          {notice}
        </div>
      )}
      {error && (
        <div className="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-xl border border-red-500/40 bg-red-950/80 px-4 py-2.5 text-sm text-danger shadow-xl backdrop-blur">
          <span className="min-w-0 break-words">{error}</span>
          <button
            onClick={clearError}
            className="shrink-0 rounded p-0.5 text-danger transition-colors hover:bg-active hover:text-danger"
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
