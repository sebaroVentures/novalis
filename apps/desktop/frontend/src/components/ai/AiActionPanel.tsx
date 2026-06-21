import { useState } from "react";

import { Check, Copy, Loader2, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAi } from "../../stores/aiStore";
import { useUi } from "../../stores/uiStore";

/** Floating panel that streams an AI action's output and offers to apply it.
 *  Mounted once at the app root; renders nothing when no run is active. */
export function AiActionPanel() {
  const { t } = useTranslation("ai");
  const run = useAi((s) => s.run);
  const [copied, setCopied] = useState(false);

  if (!run) return null;

  const streaming = run.status === "streaming";
  const hasText = run.text.trim().length > 0;

  const insert = () => {
    const ed = useUi.getState().activeEditor;
    if (ed && hasText) ed.chain().focus().insertContent(run.text).run();
    useAi.getState().clearRun();
  };

  const copy = () => {
    void navigator.clipboard.writeText(run.text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const close = () => useAi.getState().clearRun();

  return (
    <div className="fixed bottom-4 right-4 z-50 flex max-h-[60vh] w-[26rem] flex-col overflow-hidden rounded-xl border border-border-strong/80 bg-surface shadow-2xl">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
        <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-fg">
          <Sparkles size={14} className="shrink-0 text-accent" />
          <span className="truncate">{run.title}</span>
        </span>
        <span className="flex items-center gap-1.5">
          {streaming && <Loader2 size={14} className="animate-spin text-fg-muted" />}
          <button
            onClick={close}
            aria-label={t("panel.close")}
            className="rounded-md p-1 text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={15} />
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {run.status === "error" ? (
          <p className="text-sm text-danger">{run.error ?? t("panel.error")}</p>
        ) : run.text ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
            {run.text}
          </p>
        ) : (
          <p className="text-sm text-fg-faint">{t("panel.streaming")}</p>
        )}
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-border px-3 py-2">
        {streaming ? (
          <button
            onClick={() => useAi.getState().cancelRun()}
            className="rounded-md px-2.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            {t("panel.cancel")}
          </button>
        ) : (
          <>
            <button
              onClick={copy}
              disabled={!hasText}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? t("panel.copied") : t("panel.copy")}
            </button>
            <button
              onClick={insert}
              disabled={!hasText}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("panel.insert")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
