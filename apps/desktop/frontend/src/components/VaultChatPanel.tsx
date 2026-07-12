import { useEffect, useRef, useState } from "react";

import { CornerDownLeft, FileText, Loader2, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { type RagCitation } from "../ipc/api";
import { parseAnswer } from "../lib/citations";
import { useAi } from "../stores/aiStore";
import { useUi } from "../stores/uiStore";
import { useVaultChat } from "../stores/vaultChatStore";

/** Right-docked "Chat with your vault" panel: a question box, a streamed answer
 *  grounded in the vault, and clickable `[[n]]` citations that open the cited
 *  note in the workspace. Mounted once at the app root; renders nothing when
 *  closed. Consistent with the editor's right-rail panels (RelatedPanel etc.). */
export function VaultChatPanel() {
  const { t } = useTranslation(["ai", "common"]);
  const open = useVaultChat((s) => s.open);
  const status = useVaultChat((s) => s.status);
  const question = useVaultChat((s) => s.question);
  const answer = useVaultChat((s) => s.answer);
  const citations = useVaultChat((s) => s.citations);
  const error = useVaultChat((s) => s.error);

  const connections = useAi((s) => s.connections);
  const selectedId = useAi((s) => s.selectedConnectionId);
  const setSelectedConnection = useAi((s) => s.setSelectedConnection);
  const openInWorkspace = useUi((s) => s.openInWorkspace);

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load AI connections lazily the first time the panel opens.
  useEffect(() => {
    if (open && !useAi.getState().loaded) void useAi.getState().load();
  }, [open]);

  // Keep the newest answer text in view as it streams.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [answer, citations.length]);

  if (!open) return null;

  const usable = connections.filter((c) => c.enabled && c.configured && c.available);
  const selected = usable.find((c) => c.id === selectedId) ?? usable[0] ?? null;
  const streaming = status === "retrieving" || status === "streaming";
  const byId = new Map(citations.map((c) => [c.id, c]));

  const openCitation = (c: RagCitation) => openInWorkspace(c.path);

  const submit = () => {
    const q = input.trim();
    if (!q || !selected || streaming) return;
    setInput("");
    void useVaultChat.getState().ask(selected.id, q);
  };

  return (
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border bg-surface shadow-2xl">
      <header className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
        <span className="flex items-center gap-2 text-sm font-medium text-fg">
          <Sparkles size={15} className="text-accent" />
          {t("chat.title")}
        </span>
        <button
          onClick={() => useVaultChat.getState().closePanel()}
          title={t("chat.close")}
          aria-label={t("chat.close")}
          className="rounded p-1 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
        >
          <X size={15} />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {status === "idle" ? (
          <p className="mt-2 text-xs leading-relaxed text-fg-faint">{t("chat.emptyState")}</p>
        ) : (
          <div className="flex flex-col gap-3">
            {question && (
              <p className="self-end rounded-lg rounded-br-sm bg-accent/15 px-3 py-1.5 text-sm text-fg">
                {question}
              </p>
            )}

            {status === "retrieving" && (
              <div className="flex items-center gap-2 text-xs text-fg-faint">
                <Loader2 size={13} className="animate-spin" />
                {t("chat.retrieving")}
              </div>
            )}

            {status === "error" ? (
              <p className="text-sm text-danger">{error ?? t("chat.error")}</p>
            ) : (
              (answer || status === "streaming") && (
                <div className="text-sm leading-relaxed text-fg">
                  <AnswerBody answer={answer} byId={byId} onOpen={openCitation} />
                  {status === "streaming" && !answer && (
                    <span className="flex items-center gap-2 text-xs text-fg-faint">
                      <Loader2 size={13} className="animate-spin" />
                      {t("chat.thinking")}
                    </span>
                  )}
                </div>
              )
            )}

            {citations.length > 0 && (
              <div className="mt-1 flex flex-col gap-1 border-t border-border/60 pt-2.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-fg-faint">
                  {t("chat.sources")}
                </span>
                {citations.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => openCitation(c)}
                    title={c.path}
                    className="flex w-full items-start gap-2 rounded-md border border-border/60 bg-surface-2/40 px-2 py-1.5 text-left transition-colors hover:border-accent/40 hover:bg-surface-2"
                  >
                    <span className="mt-0.5 shrink-0 rounded bg-active px-1.5 text-[10px] font-medium tabular-nums text-fg-muted">
                      {c.id}
                    </span>
                    <FileText size={13} className="mt-0.5 shrink-0 text-fg-faint" />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
                      {c.title}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-border px-3 py-2.5">
        {usable.length === 0 ? (
          <p className="px-1 py-2 text-xs text-fg-faint">{t("chat.noConnections")}</p>
        ) : (
          <>
            {usable.length > 1 && (
              <select
                value={selected?.id ?? ""}
                onChange={(e) => setSelectedConnection(e.target.value)}
                className="mb-2 w-full rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-fg-muted"
              >
                {usable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
            <div className="flex items-end gap-1.5">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                rows={2}
                placeholder={t("chat.placeholder")}
                className="min-h-0 flex-1 resize-none rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-sm text-fg placeholder:text-fg-faint focus:border-accent/50 focus:outline-none"
              />
              {streaming ? (
                <button
                  onClick={() => useVaultChat.getState().cancel()}
                  className="shrink-0 rounded-md px-2.5 py-2 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  {t("chat.cancel")}
                </button>
              ) : (
                <button
                  onClick={submit}
                  disabled={!input.trim()}
                  aria-label={t("chat.send")}
                  title={t("chat.send")}
                  className="shrink-0 rounded-md bg-accent p-2 text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <CornerDownLeft size={15} />
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

/** Render a streamed answer, turning each `[[n]]` token into a clickable
 *  superscript chip that opens the cited note. An out-of-range number (a model
 *  citing a passage that wasn't retrieved) falls back to plain text. */
function AnswerBody({
  answer,
  byId,
  onOpen,
}: {
  answer: string;
  byId: Map<number, RagCitation>;
  onOpen: (c: RagCitation) => void;
}) {
  return (
    <span className="whitespace-pre-wrap break-words">
      {parseAnswer(answer).map((seg, i) => {
        if (seg.kind === "text") return <span key={i}>{seg.text}</span>;
        const c = byId.get(seg.id);
        if (!c) return <span key={i}>{`[[${seg.id}]]`}</span>;
        return (
          <button
            key={i}
            onClick={() => onOpen(c)}
            title={c.title}
            className="mx-0.5 inline-flex -translate-y-0.5 items-center rounded bg-accent/20 px-1 align-baseline text-[10px] font-semibold tabular-nums text-accent transition-colors hover:bg-accent/35"
          >
            {seg.id}
          </button>
        );
      })}
    </span>
  );
}
