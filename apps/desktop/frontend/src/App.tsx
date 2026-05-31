import { useEffect, useRef, useState } from "react";

import { Menu, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CalendarView } from "./components/CalendarView";
import { CloudHint } from "./components/CloudHint";
import { CommandPalette } from "./components/CommandPalette";
import { EditorPane } from "./components/EditorPane";
import { SearchModal } from "./components/SearchModal";
import { SettingsModal } from "./components/settings/SettingsModal";
import { Sidebar, type MainView } from "./components/Sidebar";
import { TasksView } from "./components/TasksView";
import { VaultGate } from "./components/VaultGate";
import { applyAppearance, watchSystemTheme } from "./lib/appearance";
import { applyLanguage } from "./lib/i18n";
import { getLanguage } from "./lib/language";
import { useNovalisEvents } from "./lib/useNovalisEvents";
import { usePlugins } from "./stores/pluginStore";
import { useSettings } from "./stores/settingsStore";
import { useVault } from "./stores/vaultStore";

export default function App() {
  const loading = useVault((s) => s.loading);
  const vaultPath = useVault((s) => s.vaultPath);
  const activePath = useVault((s) => s.activePath);
  const error = useVault((s) => s.error);
  const clearError = useVault((s) => s.clearError);
  const [view, setView] = useState<MainView>("notes");
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const initialViewVault = useRef<string | null>(null);
  const { t } = useTranslation();

  useNovalisEvents();

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
          if (dv === "notes" || dv === "tasks" || dv === "calendar") setView(dv);
          initialViewVault.current = vaultPath;
        }
      });
  }, [vaultPath]);

  // Re-apply theme when the OS color scheme changes (only matters for "system").
  useEffect(() => watchSystemTheme(() => useSettings.getState().prefs?.appearance), []);

  // Close the mobile nav drawer after navigating.
  useEffect(() => {
    setNavOpen(false);
  }, [view, activePath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    tasks: t("views.tasks"),
    calendar: t("views.calendar"),
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-app text-fg">
      {/* Sidebar: static from md up, slide-in drawer below md. */}
      <div
        className={`fixed inset-y-0 left-0 z-40 transition-transform md:static md:z-auto md:translate-x-0 ${
          navOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar
          view={view}
          onViewChange={setView}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-overlay md:hidden"
          onClick={() => setNavOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
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
        <div className="flex min-h-0 flex-1 flex-col">
          {view === "notes" ? <EditorPane /> : view === "tasks" ? <TasksView /> : <CalendarView />}
        </div>
      </div>

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
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
