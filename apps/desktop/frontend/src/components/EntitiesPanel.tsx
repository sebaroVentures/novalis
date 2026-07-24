import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ArrowUpRight,
  ChevronLeft,
  Loader2,
  Network,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  api,
  NovalisError,
  type EntityKind,
  type EntityMention,
  type EntitySummary,
} from "../ipc/api";
import { useAi } from "../stores/aiStore";
import { useUi } from "../stores/uiStore";

interface EntitiesPanelProps {
  /** Path of the open note — its entity backlinks are shown by default. */
  path: string;
  onClose: () => void;
  /** When stacked in a shared rail, the parent owns the width/left border. */
  stacked?: boolean;
}

/** Which entities the list shows: the open note's, or the whole vault's. */
type Scope = "note" | "all";

/** Right-hand panel for the local entity graph (W3.3): lists the people /
 *  projects / orgs / places extracted from note prose, and drills into one to
 *  show every note that mentions it ("everything about X"). Extraction is
 *  on-demand — it spends provider tokens — via the note-scoped "Extract" action;
 *  the reads are all index-only (no network). */
export function EntitiesPanel({ path, onClose, stacked }: EntitiesPanelProps) {
  const { t } = useTranslation(["ai", "common"]);
  const openInWorkspace = useUi((s) => s.openInWorkspace);
  const connections = useAi((s) => s.connections);
  const selectedId = useAi((s) => s.selectedConnectionId);

  const [scope, setScope] = useState<Scope>("note");
  const [entities, setEntities] = useState<EntitySummary[] | null>(null);
  const [error, setError] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  // The entity being drilled into ("everything about X"), or null for the list.
  const [selected, setSelected] = useState<EntitySummary | null>(null);
  const [mentions, setMentions] = useState<EntityMention[] | null>(null);

  // Localized label for an entity kind (static keys keep i18next typing happy).
  const kindLabel = (kind: EntityKind): string => {
    switch (kind) {
      case "person":
        return t("ai:entities.kind.person");
      case "project":
        return t("ai:entities.kind.project");
      case "org":
        return t("ai:entities.kind.org");
      case "place":
        return t("ai:entities.kind.place");
      default:
        return t("ai:entities.kind.other");
    }
  };

  // Load AI connections lazily so the extract action knows if one is usable.
  useEffect(() => {
    if (!useAi.getState().loaded) void useAi.getState().load();
  }, []);

  // The connection extraction runs through: the chosen one if usable, else the
  // first usable one. Null → no configured connection (extract is disabled).
  const usableConnId = useMemo(() => {
    const usable = connections.filter((c) => c.enabled && c.configured && c.available);
    return usable.find((c) => c.id === selectedId)?.id ?? usable[0]?.id ?? null;
  }, [connections, selectedId]);

  const loadEntities = useCallback(async () => {
    setError(false);
    try {
      setEntities(scope === "note" ? await api.entitiesForNote(path) : await api.entitiesList());
    } catch {
      setError(true);
    }
  }, [scope, path]);

  // Reset the drill-in and reload whenever the note or scope changes.
  useEffect(() => {
    setSelected(null);
    setMentions(null);
    void loadEntities();
  }, [loadEntities]);

  const extract = useCallback(async () => {
    if (!usableConnId) return;
    setExtracting(true);
    setExtractError(null);
    try {
      const result = await api.entitiesExtractNote(usableConnId, path);
      // The command returns this note's entities; reflect them if we're in the
      // note scope, otherwise refresh the (now larger) full list.
      if (scope === "note") setEntities(result);
      else void loadEntities();
    } catch (e) {
      setExtractError(e instanceof NovalisError ? e.message : String(e));
    } finally {
      setExtracting(false);
    }
  }, [usableConnId, path, scope, loadEntities]);

  const openEntity = useCallback(async (entity: EntitySummary) => {
    setSelected(entity);
    setMentions(null);
    try {
      setMentions(await api.entitiesMentions(entity.id));
    } catch {
      setMentions([]);
    }
  }, []);

  const containerClass = stacked
    ? "flex min-h-0 flex-1 flex-col overflow-hidden bg-surface"
    : "flex w-72 shrink-0 flex-col border-l border-border bg-surface";

  // --- drill-in: everything about one entity --------------------------------
  if (selected) {
    return (
      <aside className={containerClass}>
        <header className="flex items-center justify-between border-b border-border px-3 py-2">
          <button
            onClick={() => setSelected(null)}
            className="flex min-w-0 items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"
          >
            <ChevronLeft size={14} />
            <span className="truncate">{t("ai:entities.back")}</span>
          </button>
          <button
            onClick={onClose}
            title={t("ai:entities.hide")}
            className="rounded p-1 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={14} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
          <p className="mb-2 text-xs font-medium text-fg">
            {t("ai:entities.everythingAbout", { name: selected.name })}
          </p>
          {mentions === null && (
            <div className="flex items-center gap-2 py-2 text-xs text-fg-faint">
              <Loader2 size={13} className="animate-spin" />
              {t("common:loading")}
            </div>
          )}
          {mentions !== null && mentions.length === 0 && (
            <p className="text-xs text-fg-faint">{t("ai:entities.emptyMentions")}</p>
          )}
          {mentions?.map((m) => (
            <button
              key={`${m.notePath}:${m.charStart}`}
              onClick={() => openInWorkspace(m.notePath)}
              title={m.notePath}
              className="mb-1.5 flex w-full flex-col gap-0.5 rounded-md border border-border/60 bg-surface-2/40 px-2 py-1.5 text-left transition-colors hover:border-accent/40 hover:bg-surface-2"
            >
              <span className="truncate text-xs font-medium text-fg">{m.noteTitle}</span>
              {m.snippet && (
                <span className="line-clamp-2 text-[11px] text-fg-faint">{m.snippet}</span>
              )}
            </button>
          ))}
        </div>
      </aside>
    );
  }

  // --- list: the note's (or the vault's) entities ---------------------------
  return (
    <aside className={containerClass}>
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
          <Network size={14} />
          {t("ai:entities.title")}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => void loadEntities()}
            title={t("ai:entities.refresh")}
            className="rounded p-1 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={onClose}
            title={t("ai:entities.hide")}
            className="rounded p-1 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {/* Scope toggle: this note's entity backlinks vs. the whole vault. */}
      <div className="flex gap-1 border-b border-border px-3 py-1.5">
        {/* eslint-disable-next-line i18next/no-literal-string -- scope ids (logic keys); labels come from t() below */}
        {(["note", "all"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            aria-pressed={scope === s}
            className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
              scope === s ? "bg-active text-fg" : "text-fg-muted hover:bg-hover"
            }`}
          >
            {s === "note" ? t("ai:entities.scopeNote") : t("ai:entities.scopeAll")}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        {scope === "note" &&
          (usableConnId ? (
            <button
              onClick={() => void extract()}
              disabled={extracting}
              className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-surface-2/40 px-2 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-accent/40 hover:text-fg disabled:opacity-60"
            >
              {extracting ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  {t("ai:entities.extracting")}
                </>
              ) : (
                <>
                  <Sparkles size={13} />
                  {t("ai:entities.extract")}
                </>
              )}
            </button>
          ) : (
            <p className="mb-2 text-xs text-fg-faint">{t("ai:entities.notConfigured")}</p>
          ))}

        {extractError && <p className="mb-2 text-xs text-danger">{extractError}</p>}
        {error && <p className="text-xs text-danger">{t("ai:entities.error")}</p>}

        {!error && entities !== null && entities.length === 0 && !extracting && (
          <p className="text-xs text-fg-faint">{t("ai:entities.empty")}</p>
        )}

        {/* One guide link covers both the not-configured and the empty state
            (they can render together — a single link avoids doubling up). */}
        {((scope === "note" && !usableConnId) ||
          (!error && entities !== null && entities.length === 0 && !extracting)) && (
          <button
            type="button"
            onClick={() => useUi.getState().openHelp("entityGraph")}
            className="mt-2 flex items-center gap-1 text-xs text-fg-subtle transition-colors hover:text-fg"
          >
            {t("common:helpGuide")}
            <ArrowUpRight size={12} />
          </button>
        )}

        {entities?.map((e) => (
          <button
            key={e.id}
            onClick={() => void openEntity(e)}
            title={e.aliases.length > 0 ? e.aliases.join(", ") : undefined}
            className="mb-1.5 flex w-full items-center justify-between gap-2 rounded-md border border-border/60 bg-surface-2/40 px-2 py-1.5 text-left transition-colors hover:border-accent/40 hover:bg-surface-2"
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-medium text-fg">{e.name}</span>
              <span className="text-[10px] uppercase tracking-wide text-fg-faint">
                {kindLabel(e.kind)}
              </span>
            </span>
            <span className="shrink-0 rounded bg-active px-1.5 text-[10px] font-medium tabular-nums text-fg-muted">
              {t("ai:entities.mentionCount", { count: e.mentionCount })}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
