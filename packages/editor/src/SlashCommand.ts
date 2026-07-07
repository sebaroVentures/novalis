// SlashCommand: a `/` block-insert menu built on @tiptap/suggestion. Typing `/`
// at the start of a block (or after whitespace) opens a menu of block actions
// (headings, lists, callout, code, math, mermaid). Selecting one removes the
// `/query` text and runs the same editor.chain() the toolbar uses — only
// standard nodes / plain text, so the markdown round-trip is unaffected.

import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import { Suggestion, type SuggestionMatch, type Trigger } from "@tiptap/suggestion";
import type { Editor } from "@tiptap/react";

import { withDismissal } from "./suggestDismiss";
import { createSuggestRenderer } from "./suggestPopover";

/** Visible labels for the slash menu items (host-provided, i18n). */
export interface SlashLabels {
  heading1: string;
  heading2: string;
  heading3: string;
  bulletList: string;
  taskList: string;
  codeBlock: string;
  blockquote: string;
  callout: string;
  horizontalRule: string;
  math: string;
  mermaid: string;
}

export interface SlashCommandOptions {
  labels: SlashLabels;
}

interface SlashItem {
  title: string;
  /** Lowercase keyword haystack for filtering. */
  keywords: string;
  run: (editor: Editor) => void;
}

const slashKey = "slashCommand";

// Unicode-aware query characters: any letter/number plus `_`. `\w` would stop
// at `ü`/`é` and close the menu mid-word (e.g. `/überschrift`).
const SLASH_TOKEN_RE = /(?:^|\s)\/([\p{L}\p{N}_]*)$/u;

/** Pure core of the matcher: the `/query` token ending the given text, or
 *  null. Exported for tests. */
export function matchSlashToken(textBefore: string): { token: string; query: string } | null {
  const m = SLASH_TOKEN_RE.exec(textBefore);
  if (!m) return null;
  return { token: m[0].slice(m[0].indexOf("/")), query: m[1] };
}

/** Match a `/query` token at a block-insert-valid position (start of line or
 *  after whitespace), capturing the query. Skips code blocks so `/` in code
 *  doesn't open the menu. */
function findSlashMatch({ $position }: Trigger): SuggestionMatch {
  if ($position.parent.type.name === "codeBlock") return null;
  const from = $position.start();
  const textBefore = $position.doc.textBetween(from, $position.pos, "\n", "\0");
  const m = matchSlashToken(textBefore);
  if (!m) return null;
  return {
    range: { from: $position.pos - m.token.length, to: $position.pos },
    query: m.query,
    text: m.token,
  };
}

function buildItems(labels: SlashLabels): SlashItem[] {
  return [
    { title: labels.heading1, keywords: "h1 heading title", run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
    { title: labels.heading2, keywords: "h2 heading subtitle", run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
    { title: labels.heading3, keywords: "h3 heading", run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
    { title: labels.bulletList, keywords: "list bullet unordered ul", run: (e) => e.chain().focus().toggleBulletList().run() },
    { title: labels.taskList, keywords: "task todo checkbox", run: (e) => e.chain().focus().toggleTaskList().run() },
    { title: labels.codeBlock, keywords: "code block pre fenced", run: (e) => e.chain().focus().toggleCodeBlock().run() },
    { title: labels.blockquote, keywords: "quote blockquote", run: (e) => e.chain().focus().toggleBlockquote().run() },
    {
      title: labels.callout,
      keywords: "callout note admonition",
      run: (e) => {
        const c = e.chain().focus();
        if (!e.isActive("blockquote")) c.toggleBlockquote();
        c.insertContent("[!NOTE] ").run();
      },
    },
    { title: labels.horizontalRule, keywords: "hr divider rule separator", run: (e) => e.chain().focus().setHorizontalRule().run() },
    { title: labels.math, keywords: "math latex equation formula", run: (e) => e.chain().focus().insertContent("$$  $$").run() },
    { title: labels.mermaid, keywords: "mermaid diagram chart graph", run: (e) => e.chain().focus().toggleCodeBlock({ language: "mermaid" }).run() },
  ];
}

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: "slashCommand",

  addOptions() {
    return {
      labels: {
        heading1: "Heading 1",
        heading2: "Heading 2",
        heading3: "Heading 3",
        bulletList: "List",
        taskList: "Tasks",
        codeBlock: "Code",
        blockquote: "Quote",
        callout: "Callout",
        horizontalRule: "Horizontal rule",
        math: "Math block",
        mermaid: "Mermaid diagram",
      },
    };
  },

  addProseMirrorPlugins() {
    const allItems = buildItems(this.options.labels);
    const matcher = withDismissal(findSlashMatch); // Escape ends the session
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey(slashKey),
        char: "/",
        allowSpaces: false,
        findSuggestionMatch: matcher.findSuggestionMatch,
        items: ({ query }) => {
          const q = query.toLowerCase();
          if (!q) return allItems;
          return allItems.filter(
            (it) => it.title.toLowerCase().includes(q) || it.keywords.includes(q),
          );
        },
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run();
          props.run(editor);
        },
        render: () =>
          createSuggestRenderer<SlashItem>({
            getLabel: (it) => it.title,
            onDismiss: matcher.dismiss,
          }),
      }),
    ];
  },
});
