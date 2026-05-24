import { useEffect, useState } from "react";
import { commands } from "./ipc/bindings";
import type { AppInfo } from "./ipc/bindings";

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // M0 smoke test: round-trip through the Rust core via a typed Tauri command.
  useEffect(() => {
    commands
      .appInfo()
      .then(setInfo)
      .catch((e) => setError(String(e)));
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-neutral-950 text-neutral-100">
      <h1 className="text-4xl font-semibold tracking-tight">Novalis</h1>
      {info ? (
        <p className="text-neutral-400">
          {info.name} · v{info.version}
        </p>
      ) : error ? (
        <p className="text-red-400">IPC error: {error}</p>
      ) : (
        <p className="text-neutral-500">Connecting to core…</p>
      )}
      <p className="text-xs text-neutral-600">
        M0 scaffolding · notes + tasks + calendar
      </p>
    </main>
  );
}
