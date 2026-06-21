import { useCallback, useEffect, useRef, useState } from "react";

import { Loader2, Orbit, RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, NovalisError, type RelatedNote } from "../ipc/api";
import { useUi } from "../stores/uiStore";

const RELATED_LIMIT = 12;

interface RelatedPanelProps {
  /** Path of the open note — the anchor whose nearest neighbours we show. */
  path: string;
  onClose: () => void;
  /** When stacked in a shared rail, the parent owns the width/left border. */
  stacked?: boolean;
}

type State =
  | { kind: "loading" }
  | { kind: "ok"; notes: RelatedNote[] }
  // No embedding connection/model configured — point at Settings → AI.
  | { kind: "notConfigured" }
  // The note exists but hasn't been embedded for the current model — nudge a build.
  | { kind: "stale" }
  | { kind: "error" };

/** Right-hand panel listing notes semantically nearest to the open one, read
 *  from the on-device vector index (no network at lookup time). Distinct from
 *  the index-based LinksPanel: this is opt-in and only meaningful once the
 *  semantic index is built in Settings → AI. */
export function RelatedPanel({ path, onClose, stacked }: RelatedPanelProps) {
  const { t } = useTranslation(["links", "common"]);
  const openInWorkspace = useUi((s) => s.openInWorkspace);

  const [state, setState] = useState<State>({ kind: "loading" });
  // Ignore responses from a superseded note (fast note switching).
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    try {
      const notes = await api.aiFindRelated(path, RELATED_LIMIT);
      if (reqId.current !== id) return;
      setState({ kind: "ok", notes });
    } catch (e) {
      if (reqId.current !== id) return;
      const kind = e instanceof NovalisError ? e.kind : "";
      if (kind === "aiEmbedNotConfigured") setState({ kind: "notConfigured" });
      else if (kind === "aiEmbedStale") setState({ kind: "stale" });
      else setState({ kind: "error" });
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <aside
      className={
        stacked
          ? "flex min-h-0 flex-1 flex-col overflow-hidden bg-surface"
          : "flex w-72 shrink-0 flex-col border-l border-border bg-surface"
      }
    >
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
          <Orbit size={14} />
          {t("related.title")}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => void load()}
            title={t("related.refresh")}
            className="rounded p-1 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={onClose}
            title={t("related.hide")}
            className="rounded p-1 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        {state.kind === "loading" && (
          <div className="flex items-center gap-2 py-2 text-xs text-fg-faint">
            <Loader2 size={13} className="animate-spin" />
            {t("common:loading")}
          </div>
        )}
        {state.kind === "notConfigured" && (
          <p className="text-xs text-fg-faint">{t("related.notConfigured")}</p>
        )}
        {state.kind === "stale" && (
          <p className="text-xs text-fg-faint">{t("related.stale")}</p>
        )}
        {state.kind === "error" && (
          <p className="text-xs text-danger">{t("related.error")}</p>
        )}
        {state.kind === "ok" &&
          (state.notes.length === 0 ? (
            <p className="text-xs text-fg-faint">{t("related.empty")}</p>
          ) : (
            state.notes.map((n) => (
              <button
                key={n.path}
                onClick={() => openInWorkspace(n.path)}
                title={n.path}
                className="mb-1.5 flex w-full items-center justify-between gap-2 rounded-md border border-border/60 bg-surface-2/40 px-2 py-1.5 text-left transition-colors hover:border-accent/40 hover:bg-surface-2"
              >
                <span className="min-w-0 truncate text-xs font-medium text-fg">{n.title}</span>
                {n.score != null && (
                  <span className="shrink-0 rounded bg-active px-1.5 text-[10px] font-medium tabular-nums text-fg-muted">
                    {Math.round(n.score * 100)}%
                  </span>
                )}
              </button>
            ))
          ))}
      </div>
    </aside>
  );
}
