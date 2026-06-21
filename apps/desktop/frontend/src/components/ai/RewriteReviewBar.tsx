import { useEffect, useState } from "react";

import { Check, Loader2, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { rewriteInfo, type Editor } from "@novalis/editor";

import { useAi } from "../../stores/aiStore";

/** Floating control bar for an in-flight AI rewrite review. Shows a pending
 *  state while the proposal streams, then the inline track-changes summary with
 *  Apply / Discard. Inline per-change reject/restore lives in the editor itself
 *  (SuggestRewrite decorations); this bar commits or cancels the whole review. */
export function RewriteReviewBar({ editor }: { editor: Editor | null }) {
  const { t } = useTranslation("ai");
  const rewriting = useAi((s) => s.rewriting);
  // Re-render on every editor transaction so the kept/total counter and the
  // active state stay live as the user toggles individual changes.
  const [, force] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const bump = () => force((n) => n + 1);
    editor.on("transaction", bump);
    return () => {
      editor.off("transaction", bump);
    };
  }, [editor]);

  if (!editor) return null;

  const info = rewriteInfo(editor);
  if (!rewriting && !info.active) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-2 px-5 py-2 text-xs">
      <span className="flex min-w-0 items-center gap-2 text-fg-muted">
        <Sparkles size={14} className="shrink-0 text-accent" />
        {rewriting ? (
          <span className="flex items-center gap-1.5">
            <Loader2 size={13} className="animate-spin" />
            {t("rewrite.generating")}
          </span>
        ) : (
          <span className="truncate">
            {t("rewrite.label")} · {t("rewrite.kept", { kept: info.kept, total: info.total })}
          </span>
        )}
      </span>
      {!rewriting && (
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => editor.commands.clearSuggestions()}
            className="flex items-center gap-1 rounded-md px-2.5 py-1 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={13} />
            {t("rewrite.discard")}
          </button>
          <button
            onClick={() => editor.chain().focus().applySuggestions().run()}
            disabled={info.kept === 0}
            className="flex items-center gap-1 rounded-md bg-accent px-3 py-1 font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check size={13} />
            {t("rewrite.apply")}
          </button>
        </div>
      )}
    </div>
  );
}
