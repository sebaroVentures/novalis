import { useEffect, useState } from "react";

import { AlertTriangle, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, type ConflictDiff, type ConflictFile } from "../ipc/api";
import { useConflicts } from "../stores/conflictStore";
import { Modal } from "./ui/Modal";

export function ConflictModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation(["conflict", "common"]);
  const conflicts = useConflicts((s) => s.conflicts);
  const resolve = useConflicts((s) => s.resolve);
  const [selected, setSelected] = useState<ConflictFile | null>(null);
  const [diff, setDiff] = useState<ConflictDiff | null>(null);
  const [busy, setBusy] = useState(false);

  // Keep a valid selection as the list shrinks (after resolving).
  useEffect(() => {
    if (!open) return;
    setSelected((cur) =>
      cur && conflicts.some((c) => c.conflictPath === cur.conflictPath) ? cur : conflicts[0] ?? null,
    );
  }, [open, conflicts]);

  useEffect(() => {
    if (!selected) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    void api
      .conflictDiff(selected.originalPath, selected.conflictPath)
      .then((d) => !cancelled && setDiff(d))
      .catch(() => !cancelled && setDiff(null));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (!open) return null;

  const doResolve = async (keep: "original" | "conflict" | "both") => {
    if (!selected) return;
    setBusy(true);
    try {
      await resolve({
        keep,
        originalPath: selected.originalPath,
        conflictPath: selected.conflictPath,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      label={t("title")}
      onClose={onClose}
      overlayClassName="z-50 items-center justify-center p-6"
      panelClassName="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <AlertTriangle size={16} className="text-danger" />
          {t("title")}
        </h2>
        <button
          onClick={onClose}
          aria-label={t("common:cancel")}
          className="rounded-md p-1 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <X size={16} />
        </button>
      </header>

      {conflicts.length === 0 ? (
        <div className="px-5 py-12 text-center text-sm text-fg-faint">{t("empty")}</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <p className="px-5 pt-3 text-xs text-fg-muted">{t("description")}</p>
          <div className="flex flex-wrap gap-1.5 px-5 py-3">
            {conflicts.map((c) => (
              <button
                key={c.conflictPath}
                onClick={() => setSelected(c)}
                className={`max-w-full truncate rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  selected?.conflictPath === c.conflictPath
                    ? "border-accent bg-accent-soft text-fg"
                    : "border-border text-fg-muted hover:bg-hover"
                }`}
              >
                {c.conflictPath.split("/").pop()}
              </button>
            ))}
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-2 gap-px overflow-hidden border-y border-border bg-border">
            <DiffPane
              title={t("original")}
              subtitle={selected?.originalPath}
              content={diff?.originalExists ? diff?.originalContent : undefined}
              placeholder={diff && !diff.originalExists ? t("missing") : undefined}
            />
            <DiffPane
              title={t("conflicted")}
              subtitle={selected?.conflictPath}
              content={diff?.conflictContent}
            />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 px-5 py-3">
            <button
              disabled={busy}
              onClick={() => void doResolve("original")}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-50"
            >
              {t("keepOriginal")}
            </button>
            <button
              disabled={busy}
              onClick={() => void doResolve("conflict")}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-fg transition-colors hover:bg-hover disabled:opacity-50"
            >
              {t("keepConflict")}
            </button>
            <button
              disabled={busy}
              onClick={() => void doResolve("both")}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {t("keepBoth")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function DiffPane({
  title,
  subtitle,
  content,
  placeholder,
}: {
  title: string;
  subtitle?: string;
  content?: string;
  placeholder?: string;
}) {
  return (
    <div className="flex min-h-0 flex-col bg-surface">
      <div className="border-b border-border px-3 py-1.5">
        <div className="text-xs font-medium text-fg">{title}</div>
        {subtitle && <div className="truncate text-[11px] text-fg-faint">{subtitle}</div>}
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-muted">
        {placeholder ? <span className="italic text-fg-faint">{placeholder}</span> : content ?? ""}
      </pre>
    </div>
  );
}
