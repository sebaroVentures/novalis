import { useEffect, useState } from "react";

import { Check, GitMerge, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useGitConflicts, type MergeChoice } from "../stores/gitConflictStore";
import { Modal } from "./ui/Modal";

const KEEP_OURS: MergeChoice = { kind: "ours" };
const KEEP_THEIRS: MergeChoice = { kind: "theirs" };

/** Git merge conflict resolver (sync P3a): three-column base/ours/theirs per
 *  conflicted file, keep-mine / keep-theirs / edit-manually, finalize once
 *  every file is resolved. A SIBLING of ConflictModal (the OneDrive
 *  conflict-copy flow) — its DiffPane is module-private there, so the
 *  three-column pane lives here instead of forking that file. Open/close is
 *  store-driven: a sync that returns `Conflicted` opens it. */
export function MergeConflictModal() {
  const { t } = useTranslation(["settings", "common"]);
  const open = useGitConflicts((s) => s.open);
  const loading = useGitConflicts((s) => s.loading);
  const conflicts = useGitConflicts((s) => s.conflicts);
  const choices = useGitConflicts((s) => s.choices);
  const finalizing = useGitConflicts((s) => s.finalizing);
  const error = useGitConflicts((s) => s.error);
  const close = useGitConflicts((s) => s.close);
  const choose = useGitConflicts((s) => s.choose);
  const finalize = useGitConflicts((s) => s.finalize);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Keep a valid selection as the list (re)loads.
  useEffect(() => {
    if (!open) return;
    setSelectedPath((cur) =>
      cur && conflicts.some((c) => c.path === cur) ? cur : conflicts[0]?.path ?? null,
    );
  }, [open, conflicts]);

  if (!open) return null;

  const selected = conflicts.find((c) => c.path === selectedPath) ?? null;
  const choice = selected ? choices.get(selected.path) : undefined;
  const resolvedCount = conflicts.filter((c) => choices.has(c.path)).length;
  const allResolved = conflicts.length > 0 && resolvedCount === conflicts.length;

  // Outside JSX so the i18next literal-string rule doesn't trip on the
  // discriminants. Manual editing starts prefilled with ours ?? theirs.
  const applyChoice = (c: MergeChoice) => selected && choose(selected.path, c);
  const startManual = () => {
    if (!selected) return;
    choose(selected.path, {
      kind: "manual",
      content: choice?.kind === "manual" ? choice.content : selected.ours ?? selected.theirs ?? "",
    });
  };
  const editManual = (content: string) => {
    if (selected) choose(selected.path, { kind: "manual", content });
  };

  const choiceButton = (label: string, active: boolean, onClick: () => void) => (
    <button
      disabled={finalizing}
      onClick={onClick}
      className={`rounded-md border px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${
        active
          ? "border-accent bg-accent-soft text-fg"
          : "border-border text-fg hover:bg-hover"
      }`}
    >
      {label}
    </button>
  );

  return (
    <Modal
      label={t("sync.merge.title")}
      onClose={close}
      closeOnOverlayClick={false}
      overlayClassName="z-50 items-center justify-center p-6"
      panelClassName="flex max-h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <GitMerge size={16} className="text-danger" />
          {t("sync.merge.title")}
        </h2>
        <span className="flex items-center gap-3">
          <span className="text-xs text-fg-muted">
            {t("sync.merge.progress", { done: resolvedCount, total: conflicts.length })}
          </span>
          <button
            onClick={close}
            aria-label={t("common:cancel")}
            className="rounded-md p-1 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={16} />
          </button>
        </span>
      </header>

      {loading ? (
        <div className="px-5 py-12 text-center text-sm text-fg-faint">{t("common:loading")}</div>
      ) : conflicts.length === 0 ? (
        <div className="px-5 py-12 text-center text-sm text-fg-faint">
          {error ?? t("sync.merge.empty")}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <p className="px-5 pt-3 text-xs text-fg-muted">{t("sync.merge.description")}</p>
          <div className="flex flex-wrap gap-1.5 px-5 py-3">
            {conflicts.map((c) => (
              <button
                key={c.path}
                onClick={() => setSelectedPath(c.path)}
                className={`flex max-w-full items-center gap-1 truncate rounded-md border px-2.5 py-1 text-xs transition-colors ${
                  selected?.path === c.path
                    ? "border-accent bg-accent-soft text-fg"
                    : "border-border text-fg-muted hover:bg-hover"
                }`}
              >
                {choices.has(c.path) && <Check size={12} className="shrink-0 text-accent" />}
                <span className="truncate">{c.path}</span>
              </button>
            ))}
          </div>
          {selected && (
            <>
              <div className="grid min-h-0 flex-1 grid-cols-3 gap-px overflow-hidden border-y border-border bg-border">
                <SidePane
                  title={t("sync.merge.base")}
                  content={selected.base ?? undefined}
                  placeholder={selected.base === null ? t("sync.merge.absentBase") : undefined}
                />
                <SidePane
                  title={t("sync.merge.ours")}
                  content={selected.ours ?? undefined}
                  placeholder={selected.ours === null ? t("sync.merge.deletedOurs") : undefined}
                />
                <SidePane
                  title={t("sync.merge.theirs")}
                  content={selected.theirs ?? undefined}
                  placeholder={selected.theirs === null ? t("sync.merge.deletedTheirs") : undefined}
                />
              </div>
              {choice?.kind === "manual" && (
                <textarea
                  value={choice.content}
                  onChange={(e) => editManual(e.target.value)}
                  aria-label={t("sync.merge.manualLabel")}
                  spellCheck={false}
                  className="mx-5 mt-3 h-32 resize-y rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-fg outline-none focus:border-accent"
                />
              )}
              <div className="flex flex-wrap items-center gap-2 px-5 py-3">
                {choiceButton(t("sync.merge.keepMine"), choice?.kind === "ours", () =>
                  applyChoice(KEEP_OURS),
                )}
                {choiceButton(t("sync.merge.keepTheirs"), choice?.kind === "theirs", () =>
                  applyChoice(KEEP_THEIRS),
                )}
                {choiceButton(t("sync.merge.editManually"), choice?.kind === "manual", startManual)}
              </div>
            </>
          )}
          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
            <p className="min-w-0 break-words text-xs text-danger">{error}</p>
            <button
              disabled={!allResolved || finalizing}
              onClick={() => void finalize()}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {finalizing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <GitMerge size={14} />
              )}
              {t("sync.merge.finalize")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SidePane({
  title,
  content,
  placeholder,
}: {
  title: string;
  content?: string;
  placeholder?: string;
}) {
  return (
    <div className="flex min-h-0 flex-col bg-surface">
      <div className="border-b border-border px-3 py-1.5">
        <div className="text-xs font-medium text-fg">{title}</div>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-fg-muted">
        {placeholder ? <span className="italic text-fg-faint">{placeholder}</span> : content ?? ""}
      </pre>
    </div>
  );
}
