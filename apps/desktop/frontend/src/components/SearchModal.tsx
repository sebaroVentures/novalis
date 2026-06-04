import { useEffect, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import { api, type SearchResult } from "../ipc/api";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";

/** Render an FTS5 snippet, turning its `<mark>…</mark>` runs into highlights and
 *  rendering everything else as auto-escaped text (no innerHTML). */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<mark>|<\/mark>)/);
  let on = false;
  return (
    <>
      {parts.map((p, i) => {
        if (p === "<mark>") {
          on = true;
          return null;
        }
        if (p === "</mark>") {
          on = false;
          return null;
        }
        if (!p) return null;
        return on ? (
          <mark key={i} className="rounded bg-accent-soft px-0.5 text-accent">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </>
  );
}

export function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation("vault");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const openNote = useVault((s) => s.openNote);
  const setView = useUi((s) => s.setView);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSelected(0);
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
      .search(query)
      .then((r) => {
        if (!cancelled) {
          setResults(r);
          setSelected(0);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [query, open]);

  if (!open) return null;

  const pick = (path: string) => {
    setView("notes"); // search can run from any view; make the editor visible
    void openNote(path);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      const r = results[selected];
      if (r) pick(r.path);
    }
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
          placeholder={t("searchPlaceholder")}
          className="w-full bg-transparent px-4 py-3 text-fg outline-none placeholder:text-fg-faint"
          onKeyDown={onKeyDown}
        />
        {query.trim() && results.length === 0 && (
          <div className="border-t border-border px-4 py-3 text-xs text-fg-faint">
            {t("searchNoResults")}
          </div>
        )}
        {results.length > 0 && (
          <ul className="max-h-80 overflow-y-auto border-t border-border">
            {results.map((r, i) => (
              <li key={r.path}>
                <button
                  onMouseMove={() => setSelected(i)}
                  onClick={() => pick(r.path)}
                  className={`flex w-full flex-col gap-0.5 px-4 py-2 text-left ${
                    i === selected ? "bg-active" : "hover:bg-hover"
                  }`}
                >
                  <span className="text-sm text-fg">{r.title}</span>
                  {r.snippet && (
                    <span className="line-clamp-2 text-xs text-fg-muted">
                      <Snippet text={r.snippet} />
                    </span>
                  )}
                  <span className="truncate text-[11px] text-fg-faint">{r.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
