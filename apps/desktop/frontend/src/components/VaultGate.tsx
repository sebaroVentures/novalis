import { useVault } from "../stores/vaultStore";

/** Shown when no vault is open: prompts the user to pick a folder. */
export function VaultGate() {
  const pickAndOpen = useVault((s) => s.pickAndOpen);
  const error = useVault((s) => s.error);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-950 text-neutral-100">
      <div className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Novalis</h1>
        <p className="mt-2 text-neutral-500">Local-first notes, tasks &amp; calendar</p>
      </div>
      <button
        onClick={() => void pickAndOpen()}
        className="rounded-lg bg-indigo-500 px-5 py-2.5 font-medium text-white transition hover:bg-indigo-400"
      >
        Open a vault…
      </button>
      <p className="max-w-sm text-center text-xs text-neutral-600">
        Choose a folder of Markdown files (e.g. your OneDrive NexusNotes folder).
        Novalis reads and writes plain <code>.md</code> files — nothing leaves your device.
      </p>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </main>
  );
}
