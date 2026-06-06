import { useCallback, useEffect, useRef, useState } from "react";

import { Link2, Loader2, Network, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, type LinkReference } from "../ipc/api";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";
import { GraphModal } from "./GraphModal";

interface LinksPanelProps {
  /** Title of the open note — the link target whose references we show. */
  title: string;
  /** Path of the open note, excluded from its own "unlinked mentions". */
  path: string;
  onClose: () => void;
  /** When stacked in a shared rail, the parent owns the width/left border. */
  stacked?: boolean;
}

/** Right-hand panel showing notes that link to the open note ("linked
 *  references") and notes that name it without linking ("unlinked mentions"),
 *  each with the line where it occurs. Backed by the same wikilink index the
 *  editor writes on every save. */
export function LinksPanel({ title, path, onClose, stacked }: LinksPanelProps) {
  const { t } = useTranslation(["links", "common"]);
  const openInWorkspace = useUi((s) => s.openInWorkspace);
  const invalidateNote = useVault((s) => s.invalidateNote);

  const [backlinks, setBacklinks] = useState<LinkReference[]>([]);
  const [mentions, setMentions] = useState<LinkReference[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  // Ignore responses from a superseded note/title (fast note switching).
  const reqId = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const [bl, um] = await Promise.all([
        api.backlinks(title),
        api.unlinkedMentions(title, path),
      ]);
      if (reqId.current !== id) return;
      setBacklinks(bl);
      setMentions(um);
    } catch {
      // noVault / engine not ready — leave the lists empty.
      if (reqId.current === id) {
        setBacklinks([]);
        setMentions([]);
      }
    } finally {
      if (reqId.current === id) setLoading(false);
    }
  }, [title, path]);

  useEffect(() => {
    void load();
  }, [load]);

  const onLink = async (ref: LinkReference, line: number) => {
    setError(null);
    try {
      await api.linkMention(ref.path, title, line);
      // Drop the edited note's cache so re-opening it shows the new `[[link]]`.
      invalidateNote(ref.path);
      await load();
    } catch {
      setError(t("linkFailed"));
    }
  };

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
          <Link2 size={14} />
          {t("title")}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setGraphOpen(true)}
            title={t("graph")}
            className="rounded p-1 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
          >
            <Network size={14} />
          </button>
          <button
            onClick={onClose}
            title={t("hide")}
            className="rounded p-1 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        {loading && backlinks.length === 0 && mentions.length === 0 ? (
          <div className="flex items-center gap-2 py-2 text-xs text-fg-faint">
            <Loader2 size={13} className="animate-spin" />
            {t("common:loading")}
          </div>
        ) : (
          <>
            <Section label={t("backlinks")} count={backlinks.length} empty={t("noBacklinks")}>
              {backlinks.map((r) => (
                <ReferenceCard key={r.path} reference={r} onOpen={() => openInWorkspace(r.path)} />
              ))}
            </Section>
            <Section
              label={t("mentions")}
              count={mentions.length}
              empty={t("noMentions")}
              className="mt-4"
            >
              {mentions.map((r) => (
                <ReferenceCard
                  key={r.path}
                  reference={r}
                  onOpen={() => openInWorkspace(r.path)}
                  linkLabel={t("link")}
                  linkTitle={t("linkTitle")}
                  onLink={(line) => void onLink(r, line)}
                />
              ))}
            </Section>
            {error && <p className="mt-3 text-xs text-danger">{error}</p>}
          </>
        )}
      </div>

      <GraphModal open={graphOpen} path={path} onClose={() => setGraphOpen(false)} />
    </aside>
  );
}

function Section({
  label,
  count,
  empty,
  className,
  children,
}: {
  label: string;
  count: number;
  empty: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
        {label}
        <span className="rounded bg-active px-1.5 text-[10px] font-medium text-fg-muted">{count}</span>
      </h3>
      {count === 0 ? <p className="text-xs text-fg-faint">{empty}</p> : children}
    </section>
  );
}

function ReferenceCard({
  reference,
  onOpen,
  onLink,
  linkLabel,
  linkTitle,
}: {
  reference: LinkReference;
  onOpen: () => void;
  onLink?: (line: number) => void;
  linkLabel?: string;
  linkTitle?: string;
}) {
  return (
    <div className="mb-2 overflow-hidden rounded-md border border-border/60 bg-surface-2/40">
      <button
        onClick={onOpen}
        className="block w-full truncate px-2 py-1.5 text-left text-xs font-medium text-fg transition-colors hover:text-accent"
        title={reference.path}
      >
        {reference.title}
      </button>
      {reference.matches.length > 0 && (
        <ul className="px-2 pb-1.5">
          {reference.matches.map((m, i) => (
            <li key={`${m.line}:${i}`} className="flex items-start gap-1.5 py-0.5">
              <button
                onClick={onOpen}
                title={m.snippet}
                className="min-w-0 flex-1 truncate text-left text-xs text-fg-faint transition-colors hover:text-fg-muted"
              >
                {m.snippet}
              </button>
              {onLink && (
                <button
                  onClick={() => onLink(m.line)}
                  title={linkTitle}
                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/10"
                >
                  {linkLabel}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
