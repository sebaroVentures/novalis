import { useEffect, useRef, useState } from "react";

import { api, type NoteSummary } from "../ipc/api";
import { useVault } from "../stores/vaultStore";

export function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteSummary[]>([]);
  const openNote = useVault((s) => s.openNote);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    void api
      .quickSearch(query)
      .then((r) => {
        if (!cancelled) setResults(r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [query, open]);

  if (!open) return null;

  const pick = (path: string) => {
    void openNote(path);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-28"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes by title…"
          className="w-full bg-transparent px-4 py-3 text-neutral-100 outline-none placeholder:text-neutral-600"
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && results[0]) pick(results[0].path);
          }}
        />
        {results.length > 0 && (
          <ul className="max-h-80 overflow-y-auto border-t border-neutral-800">
            {results.map((r) => (
              <li key={r.path}>
                <button
                  onClick={() => pick(r.path)}
                  className="flex w-full flex-col px-4 py-2 text-left hover:bg-white/5"
                >
                  <span className="text-sm text-neutral-100">{r.title}</span>
                  <span className="text-xs text-neutral-600">{r.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
