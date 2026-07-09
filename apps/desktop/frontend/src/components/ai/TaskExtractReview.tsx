import { useCallback, useEffect, useRef, useState } from "react";

import { Loader2, ListTodo, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getMarkdown } from "@novalis/editor";

import {
  appendUnderActions,
  buildTaskLine,
  frontmatterOf,
  parseExtractedTasks,
  type ProposedTask,
} from "../../lib/taskExtract";
import { useAi, type TaskExtractTarget } from "../../stores/aiStore";
import { useVault } from "../../stores/vaultStore";
import { Modal } from "../ui/Modal";

interface Row extends ProposedTask {
  id: number;
  included: boolean;
}

/** Store-mounted host: renders the review modal for the note the editor menu /
 *  command palette opened it against. Keyed by note path so each open starts
 *  fresh. */
export function TaskExtractReview() {
  const target = useAi((s) => s.taskExtract);
  const close = useAi((s) => s.closeTaskExtract);
  if (!target) return null;
  return <TaskExtractModal key={target.notePath} target={target} onClose={close} />;
}

type Status = "loading" | "ready" | "error";

function TaskExtractModal({
  target,
  onClose,
}: {
  target: TaskExtractTarget;
  onClose: () => void;
}) {
  const { t } = useTranslation("ai");
  const connections = useAi((s) => s.connections);
  const selectedId = useAi((s) => s.selectedConnectionId);

  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);

  // Guard against a late collectAiAction resolve after the modal unmounts.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const usable = connections.filter((c) => c.enabled && c.configured && c.available);
  const selected = usable.find((c) => c.id === selectedId) ?? usable[0] ?? null;

  const run = useCallback(async () => {
    if (!selected) {
      setStatus("error");
      setError(t("menu.noConnections"));
      return;
    }
    setStatus("loading");
    setError(null);
    try {
      const raw = await useAi.getState().collectAiAction({
        connectionId: selected.id,
        actionId: "extract-tasks",
        notePath: target.notePath,
        context: { title: target.noteTitle, markdown: target.body },
      });
      if (!alive.current) return;
      // Parse defensively + dedupe against the note's existing task lines.
      const next: Row[] = parseExtractedTasks(raw, target.body).map((p, id) => ({
        id,
        included: true,
        ...p,
      }));
      setRows(next);
      setStatus("ready");
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
    // target/selected are stable for the modal's lifetime (keyed remount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  useEffect(() => {
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chosen = rows.filter((r) => r.included && r.text.trim());

  const add = async () => {
    if (!chosen.length || saving) return;
    setSaving(true);
    setError(null);
    try {
      const newLines = chosen.map((r) =>
        buildTaskLine({
          text: r.text,
          due: r.due,
          start: r.start,
          project: r.project,
          priority: r.priority,
        }),
      );
      // Flush any pending editor autosave so we build on the note's true current
      // body, then write once. The write reindexes the note (tasks appear in
      // Kanban/Today) and remounts the editor with the new "## Actions" section.
      await useVault.getState().flushActive();
      const stored = useVault.getState().openNotes.get(target.notePath);
      // The note should still be open (the review opened over its editor). If it
      // isn't cached we can't recover its frontmatter — abort rather than write
      // a body that would drop the note's tags/aliases/properties.
      if (!stored) {
        setError(t("extract.saveError"));
        setSaving(false);
        return;
      }
      const fm = frontmatterOf(stored.content);
      const ed = target.editor;
      const freshBody = ed && !ed.isDestroyed ? getMarkdown(ed) : target.body;
      const newBody = appendUnderActions(freshBody, newLines);
      await useVault.getState().saveNote(target.notePath, fm + newBody);
      if (!alive.current) return;
      if ((useVault.getState().saveStates.get(target.notePath) ?? "idle") === "error") {
        setError(t("extract.saveError"));
        setSaving(false);
        return;
      }
      onClose();
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      label={t("extract.title")}
      onClose={onClose}
      overlayClassName="z-50 items-start justify-center pt-24"
      panelClassName="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-medium text-fg">
          <ListTodo size={15} className="text-accent" />
          {t("extract.title")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("extract.cancel")}
          className="rounded-md p-1 text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <X size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {status === "loading" && (
          <span className="flex items-center gap-2 py-2 text-xs text-fg-faint">
            <Loader2 size={13} className="animate-spin" />
            {t("extract.analyzing")}
          </span>
        )}

        {status === "error" && (
          <div className="flex items-center justify-between gap-2 py-1 text-xs">
            <span className="min-w-0 break-words text-danger">{error ?? t("extract.error")}</span>
            <button
              type="button"
              onClick={() => void run()}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            >
              {t("extract.retry")}
            </button>
          </div>
        )}

        {status === "ready" && rows.length === 0 && (
          <span className="py-2 text-xs text-fg-faint">{t("extract.empty")}</span>
        )}

        {status === "ready" && rows.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <TaskRow
                key={row.id}
                row={row}
                onToggle={() =>
                  setRows((rs) =>
                    rs.map((r) => (r.id === row.id ? { ...r, included: !r.included } : r)),
                  )
                }
                onText={(text) =>
                  setRows((rs) => rs.map((r) => (r.id === row.id ? { ...r, text } : r)))
                }
                labels={{
                  include: t("extract.include"),
                  placeholder: t("extract.textPlaceholder"),
                  priority: t("extract.priority"),
                  start: t("extract.start"),
                  due: t("extract.due"),
                  project: t("extract.project"),
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
        <span className="text-xs text-fg-faint">
          {status === "error" && error ? error : null}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            {t("extract.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void add()}
            disabled={chosen.length === 0 || saving}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && <Loader2 size={13} className="animate-spin" />}
            {t("extract.add", { count: chosen.length })}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TaskRow({
  row,
  onToggle,
  onText,
  labels,
}: {
  row: Row;
  onToggle: () => void;
  onText: (text: string) => void;
  labels: {
    include: string;
    placeholder: string;
    priority: string;
    start: string;
    due: string;
    project: string;
  };
}) {
  return (
    <div
      className={`flex items-start gap-2 rounded-md border border-border bg-surface-2/40 px-2 py-1.5 ${
        row.included ? "" : "opacity-50"
      }`}
    >
      <input
        type="checkbox"
        checked={row.included}
        onChange={onToggle}
        aria-label={labels.include}
        className="mt-1.5 accent-accent"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          value={row.text}
          onChange={(e) => onText(e.target.value)}
          placeholder={labels.placeholder}
          className="w-full rounded bg-surface px-2 py-1 text-xs text-fg outline-none ring-1 ring-transparent transition placeholder:text-fg-faint focus:ring-accent/40"
        />
        {(row.priority || row.start || row.due || row.project) && (
          <div className="flex flex-wrap gap-1">
            {row.priority && <MetaChip label={labels.priority} value={row.priority} />}
            {row.start && <MetaChip label={labels.start} value={row.start} />}
            {row.due && <MetaChip label={labels.due} value={row.due} />}
            {row.project && <MetaChip label={labels.project} value={row.project} />}
          </div>
        )}
      </div>
    </div>
  );
}

function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-1.5 py-0.5 text-[10px] text-fg-muted">
      <span className="uppercase tracking-wide text-fg-faint">{label}</span>
      <span className="text-fg">{value}</span>
    </span>
  );
}
