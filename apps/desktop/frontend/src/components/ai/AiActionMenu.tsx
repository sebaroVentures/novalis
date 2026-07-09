import { useEffect, useRef, useState } from "react";

import { Check, ChevronDown, Globe, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getMarkdown, type Editor } from "@novalis/editor";

import type { AiActionView, AiTemplate } from "../../ipc/api";
import { useDismiss } from "../../lib/useDismiss";
import { useAi } from "../../stores/aiStore";

// Static id → i18n key map (typed i18next rejects template-built keys).
const ACTION_TITLE_KEY = {
  summarize: "action.summarize.title",
  compose: "action.compose.title",
  challenge: "action.challenge.title",
  rewrite: "action.rewrite.title",
} as const;
// Action titles resolve at runtime by id, so list the keys for the extractor:
// t("ai:action.summarize.title")
// t("ai:action.compose.title")
// t("ai:action.challenge.title")
// t("ai:action.rewrite.title")

/** The "AI" dropdown in the editor header: pick a model, run an action. Shows
 *  only connections that are enabled, have a key, and are available. */
export function AiActionMenu({
  editor,
  noteTitle,
  notePath,
}: {
  editor: Editor | null;
  noteTitle: string;
  notePath: string | null;
}) {
  const { t } = useTranslation("ai");
  const connections = useAi((s) => s.connections);
  const actions = useAi((s) => s.actions);
  const templates = useAi((s) => s.templates);
  const selectedId = useAi((s) => s.selectedConnectionId);
  const [open, setOpen] = useState(false);
  // When set, the dropdown shows a prompt box for a required-input action.
  const [prompting, setPrompting] = useState<AiActionView | null>(null);
  const [promptText, setPromptText] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const closeMenu = () => {
    setOpen(false);
    setPrompting(null);
    setPromptText("");
  };

  useEffect(() => {
    if (!useAi.getState().loaded) void useAi.getState().load();
  }, []);

  useDismiss(ref, open, closeMenu);

  const usable = connections.filter((c) => c.enabled && c.configured && c.available);
  const selected = usable.find((c) => c.id === selectedId) ?? usable[0] ?? null;

  const actionTitle = (a: AiActionView): string => {
    const key = ACTION_TITLE_KEY[a.id as keyof typeof ACTION_TITLE_KEY];
    return key ? t(key) : a.id;
  };

  // Live selection state (read when the menu renders); the rewrite action needs
  // a selection, and ProseMirror keeps it while focus is on the menu button.
  const hasSelection = !!editor && !editor.state.selection.empty;

  const run = (a: AiActionView, userInput?: string) => {
    if (!editor || !selected) return;
    // Rewrite doesn't stream into the panel — it opens an inline track-changes
    // review over the captured selection (see SuggestRewrite).
    if (a.id === "rewrite") {
      const sel = editor.state.selection;
      if (sel.empty) {
        closeMenu();
        return;
      }
      const { from, to } = sel;
      void useAi.getState().runRewrite({
        editor,
        connectionId: selected.id,
        notePath,
        noteTitle,
        from,
        to,
        selection: editor.state.doc.textBetween(from, to, "\n"),
        userInput: userInput ?? null,
      });
      closeMenu();
      return;
    }
    const sel = editor.state.selection;
    const selection = sel.empty ? null : editor.state.doc.textBetween(sel.from, sel.to, "\n");
    void useAi.getState().startRun({
      connectionId: selected.id,
      actionId: a.id,
      title: actionTitle(a),
      notePath,
      context: { title: noteTitle, markdown: getMarkdown(editor), selection },
      userInput: userInput ?? null,
    });
    closeMenu();
  };

  // A user template runs through the hidden "custom" action: its body is the
  // instruction applied to the note/selection.
  const runTemplate = (tpl: AiTemplate) => {
    if (!editor || !selected) return;
    const sel = editor.state.selection;
    const selection = sel.empty ? null : editor.state.doc.textBetween(sel.from, sel.to, "\n");
    void useAi.getState().startRun({
      connectionId: selected.id,
      actionId: "custom",
      title: tpl.name,
      notePath,
      context: { title: noteTitle, markdown: getMarkdown(editor), selection },
      userInput: tpl.body,
    });
    closeMenu();
  };

  // "Extract tasks" is a whole-note action: open the review card for this note
  // (no selection required). The card runs the hidden `extract-tasks` action.
  const onExtractTasks = () => {
    if (!editor || !selected || !notePath) return;
    useAi.getState().startTaskExtract({
      editor,
      notePath,
      noteTitle,
      body: getMarkdown(editor),
    });
    closeMenu();
  };

  // Required-input actions open a prompt box; others run on click.
  const onActionClick = (a: AiActionView) => {
    if (a.input === "required") {
      setPrompting(a);
      setPromptText("");
    } else {
      run(a);
    }
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => {
          if (open) {
            closeMenu();
          } else {
            setOpen(true);
            // Refresh on open so per-vault templates reflect the current vault.
            void useAi.getState().load();
          }
        }}
        title={t("menu.button")}
        aria-label={t("menu.button")}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-fg-muted transition-colors hover:bg-active hover:text-fg"
      >
        <Sparkles size={15} />
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-64 overflow-hidden rounded-lg border border-border-strong/80 bg-surface p-1 shadow-xl">
          {prompting ? (
            <div className="p-1.5">
              <div className="px-1 pb-1.5 text-xs font-medium text-fg">{actionTitle(prompting)}</div>
              <textarea
                autoFocus
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                placeholder={t("menu.promptPlaceholder")}
                rows={3}
                className="w-full resize-none rounded-md bg-surface-2 px-2 py-1.5 text-xs text-fg outline-none ring-1 ring-transparent transition placeholder:text-fg-faint focus:ring-accent/50"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && promptText.trim()) {
                    run(prompting, promptText);
                  }
                }}
              />
              <div className="mt-1.5 flex items-center justify-end gap-1.5">
                <button
                  onClick={() => {
                    setPrompting(null);
                    setPromptText("");
                  }}
                  className="rounded-md px-2.5 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  {t("menu.cancel")}
                </button>
                <button
                  onClick={() => run(prompting, promptText)}
                  disabled={!editor || !promptText.trim()}
                  className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("menu.run")}
                </button>
              </div>
            </div>
          ) : usable.length === 0 ? (
            <div className="px-2.5 py-2 text-xs">
              <p className="text-fg-muted">{t("menu.noConnections")}</p>
              <p className="mt-0.5 text-fg-faint">{t("menu.configureHint")}</p>
            </div>
          ) : (
            <>
              {usable.length > 1 && (
                <>
                  <div className="px-1.5 pb-1 pt-1 text-[11px] uppercase tracking-wide text-fg-faint">
                    {t("menu.modelHeading")}
                  </div>
                  {usable.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => useAi.getState().setSelectedConnection(c.id)}
                      className={`flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-hover ${
                        selected?.id === c.id ? "text-accent" : "text-fg-muted"
                      }`}
                    >
                      <span className="truncate">{c.label}</span>
                      {selected?.id === c.id && <Check size={13} className="shrink-0" />}
                    </button>
                  ))}
                  <div className="my-1 border-t border-border" />
                </>
              )}
              <div className="px-1.5 pb-1 pt-1 text-[11px] uppercase tracking-wide text-fg-faint">
                {t("menu.actionsHeading")}
              </div>
              {actions.map((a) => {
                // Rewrite needs a selection to act on.
                const needsSelection = a.id === "rewrite" && !hasSelection;
                return (
                  <button
                    key={a.id}
                    onClick={() => onActionClick(a)}
                    disabled={!editor || needsSelection}
                    title={needsSelection ? t("menu.selectFirst") : undefined}
                    className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-fg transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {actionTitle(a)}
                  </button>
                );
              })}
              {/* Extract tasks: a hidden whole-note action (no selection needed),
                  opening the accept/reject review card via the store. */}
              <button
                onClick={onExtractTasks}
                disabled={!editor || !notePath}
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-fg transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("extract.menuItem")}
              </button>
              {templates.length > 0 && (
                <>
                  <div className="my-1 border-t border-border" />
                  <div className="px-1.5 pb-1 pt-1 text-[11px] uppercase tracking-wide text-fg-faint">
                    {t("menu.templatesHeading")}
                  </div>
                  {templates.map((tpl) => (
                    <button
                      key={`${tpl.scope}:${tpl.id}`}
                      onClick={() => runTemplate(tpl)}
                      disabled={!editor}
                      title={tpl.name}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-fg transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="truncate">{tpl.name}</span>
                      {tpl.scope === "global" && (
                        <Globe size={12} className="shrink-0 text-fg-faint" />
                      )}
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
