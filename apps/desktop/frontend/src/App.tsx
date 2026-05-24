import { useEffect, useState } from "react";

import { EditorPane } from "./components/EditorPane";
import { SearchModal } from "./components/SearchModal";
import { Sidebar, type MainView } from "./components/Sidebar";
import { TasksView } from "./components/TasksView";
import { VaultGate } from "./components/VaultGate";
import { useNovalisEvents } from "./lib/useNovalisEvents";
import { useVault } from "./stores/vaultStore";

export default function App() {
  const loading = useVault((s) => s.loading);
  const vaultPath = useVault((s) => s.vaultPath);
  const error = useVault((s) => s.error);
  const clearError = useVault((s) => s.clearError);
  const [view, setView] = useState<MainView>("notes");
  const [searchOpen, setSearchOpen] = useState(false);

  useNovalisEvents();

  useEffect(() => {
    void useVault.getState().sync();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-500">
        Loading…
      </main>
    );
  }

  if (!vaultPath) return <VaultGate />;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100">
      <Sidebar view={view} onViewChange={setView} onOpenSearch={() => setSearchOpen(true)} />
      {view === "notes" ? <EditorPane /> : <TasksView />}
      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      {error && (
        <div className="fixed bottom-4 right-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border border-red-500/40 bg-red-950/80 px-4 py-2 text-sm text-red-200">
          <span className="min-w-0 break-words">{error}</span>
          <button onClick={clearError} className="text-red-400 hover:text-red-200">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
