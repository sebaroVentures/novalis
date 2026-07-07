import { useEffect, useMemo, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import { api, type FolderNode, type SearchResult, type TagCount } from "../ipc/api";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";
import { Modal } from "./ui/Modal";

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
  const [folder, setFolder] = useState("");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<TagCount[]>([]);
  const openInWorkspace = useUi((s) => s.openInWorkspace);
  const tree = useVault((s) => s.tree);
  const reportError = useVault((s) => s.reportError);
  const inputRef = useRef<HTMLInputElement>(null);

  const folders = useMemo(() => {
    const out: string[] = [];
    const walk = (n: FolderNode) => {
      for (const c of n.children) {
        out.push(c.path);
        walk(c);
      }
    };
    if (tree) walk(tree);
    return out.sort();
  }, [tree]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSelected(0);
      setFolder("");
      setTag("");
      void api.listTags().then(setTags).catch(() => setTags([]));
    }
  }, [open]);

  useEffect(() => {
    if (!open || !query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    void api
      .search(query, folder || null, tag || null)
      .then((r) => {
        if (!cancelled) {
          setResults(r);
          setSelected(0);
        }
      })
      .catch((e) => {
        // Don't leave the previous query's hits standing under a failed search.
        if (!cancelled) {
          setResults([]);
          reportError(e);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [query, folder, tag, open, reportError]);

  if (!open) return null;

  const pick = (path: string) => {
    // openInWorkspace makes the editor visible (search can run from any view),
    // opens/activates the tab, and loads the note.
    openInWorkspace(path);
    onClose();
  };

  // Escape is handled by the Modal shell (close, restore focus).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
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
    <Modal
      label={t("searchPlaceholder")}
      onClose={onClose}
      initialFocusRef={inputRef}
      overlayClassName="z-50 items-start justify-center pt-28"
      panelClassName="w-full max-w-lg overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("searchPlaceholder")}
        className="w-full bg-transparent px-4 py-3 text-fg outline-none placeholder:text-fg-faint"
        onKeyDown={onKeyDown}
      />
      {(folders.length > 0 || tags.length > 0) && (
        <div className="flex items-center gap-2 border-t border-border px-3 py-1.5">
          {folders.length > 0 && (
            <select
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              className="rounded-md bg-surface-2 px-2 py-1 text-xs text-fg outline-none ring-1 ring-border focus:ring-accent/50"
            >
              <option value="">{t("searchAllFolders")}</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
          {tags.length > 0 && (
            <select
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              className="rounded-md bg-surface-2 px-2 py-1 text-xs text-fg outline-none ring-1 ring-border focus:ring-accent/50"
            >
              <option value="">{t("searchAllTags")}</option>
              {tags.map((tc) => (
                <option key={tc.tag} value={tc.tag}>
                  #{tc.tag} ({tc.count})
                </option>
              ))}
            </select>
          )}
        </div>
      )}
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
    </Modal>
  );
}
