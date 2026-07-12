import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { mergeAttributes, type Extensions } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, type Editor, useEditor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import { Markdown } from "tiptap-markdown";

import { BlockRef, type BlockRefResult } from "./BlockRef";
import { BlockRefSuggestion, type BlockCandidate } from "./BlockRefSuggestion";
import { Callout } from "./Callout";
import { Embed, type EmbedResult } from "./Embed";
import { Find } from "./Find";
import { MarkdownText } from "./MarkdownText";
import { MathExtension } from "./Math";
import { MermaidCodeBlock } from "./MermaidCodeBlock";
import { SlashCommand } from "./SlashCommand";
import { SuggestRewrite } from "./SuggestRewrite";
import { TagSuggestion } from "./TagSuggestion";
import { WikiLink } from "./WikiLink";
import { WikiLinkSuggestion } from "./WikiLinkSuggestion";

// Shared lowlight registry (highlight.js "common" set, ~37 languages), created
// once at module scope so the language registry is stable across editor mounts.
const lowlight = createLowlight(common);

// `![[embed]]` transclusions render a nested read-only editor. Bound the
// recursion so a cycle (`![[A]]` ⇄ `![[B]]`) can't blow the stack: past this
// depth the Embed extension is simply not registered, so inner `![[…]]` stays
// inert literal text.
const MAX_EMBED_DEPTH = 3;

export interface NovalisEditorProps {
  /** Initial markdown content. Remount (via a React `key`) to load another note. */
  value: string;
  /** Called with the full markdown on every edit. */
  onChange?: (markdown: string) => void;
  editable?: boolean;
  placeholder?: string;
  /** Persist a pasted/dropped image; returns the markdown-relative path (or null). */
  onUploadImage?: (file: File) => Promise<string | null>;
  /** Map a stored (relative) image src to a displayable URL. */
  resolveImageSrc?: (src: string) => string;
  /** Called when the user clicks a `[[wikilink]]`. Host resolves+opens. */
  onWikiLinkClick?: (title: string) => void;
  /** Resolve a `![[transclusion]]` target to a renderable result (note body,
   *  image src, or missing). Host classifies images by extension and resolves
   *  notes via its index/IPC. Omitted → embeds stay as loading placeholders. */
  onResolveEmbed?: (target: string) => Promise<EmbedResult>;
  /** Open (creating if absent) an embedded note — the embed's "open note"
   *  affordance and the click target of a missing-embed chip. */
  onOpenNote?: (target: string) => void;
  /** Current transclusion nesting depth. Top-level hosts pass 0 (or omit);
   *  nested embed editors pass parent + 1. Embed is registered only while
   *  `embedDepth < MAX_EMBED_DEPTH`, which terminates recursion. Default 0. */
  embedDepth?: number;
  /** Search note titles for the `[[` autocomplete. Host wires it to its index;
   *  results are shown in a popover and inserted as plain `[[Title]]` text. */
  onSearchLinkTargets?: (query: string) => Promise<{ title: string; path: string }[]>;
  /** Search existing tags for the `#` autocomplete. Host wires it to its index;
   *  returns bare tags (no `#`), inserted as plain `#tag` text. */
  onSearchTags?: (query: string) => Promise<string[]>;
  /** Search tagged blocks for the `((` autocomplete. Host wires it to its block
   *  index; results are inserted as plain `((^id))` text. */
  onSearchBlocks?: (query: string) => Promise<BlockCandidate[]>;
  /** Resolve a `((^id))` reference to its block (note + text) for inline
   *  rendering. Host-owned (IPC → block index). Omitted → chips stay loading. */
  onResolveBlock?: (id: string) => Promise<BlockRefResult>;
  /** Open the note a `((^id))` reference points at (click on a resolved chip).
   *  Receives the block's note PATH (not a title). */
  onOpenBlock?: (notePath: string) => void;
  /** Pointer entered a `[[wikilink]]` — host may show a preview at `rect`. */
  onWikiLinkHover?: (title: string, rect: DOMRect) => void;
  /** Pointer left the hovered wikilink. */
  onWikiLinkHoverEnd?: () => void;
  /** Called once the underlying TipTap editor instance exists, and again if it
   *  is recreated. The host uses it to read the outline and scroll to headings. */
  onEditorReady?: (editor: Editor) => void;
  /** Open the in-note find/replace bar (host renders it). Wired to Cmd/Ctrl+F. */
  onFindToggle?: () => void;
  /** Debounce (ms) for full-document markdown serialization. Default 200. */
  serializeMs?: number;
  /** Browser spellcheck in the editable area. Default true. */
  spellCheck?: boolean;
  /** Localized UI strings (placeholder + toolbar). The host fills these from its
   *  i18n catalog; any omitted fall back to the English defaults. */
  labels?: Partial<NovalisEditorLabels>;
}

/** User-facing strings the editor renders. Exposed as a prop (with English
 *  defaults) so the package stays framework- and i18n-agnostic — the host owns
 *  translation. The B/I/H1/H2 buttons show fixed typographic glyphs; these
 *  strings are their accessible names (tooltip / aria-label). */
export interface NovalisEditorLabels {
  placeholder: string;
  bold: string;
  italic: string;
  heading1: string;
  heading2: string;
  bulletList: string;
  taskList: string;
  codeBlock: string;
  blockquote: string;
  heading3: string;
  strike: string;
  horizontalRule: string;
  callout: string;
  mermaidShowSource: string;
  mermaidShowDiagram: string;
  /** Slash-menu item to insert a `$$ $$` math block. */
  slashMath: string;
  /** Slash-menu item to insert a ```mermaid code block. */
  slashMermaid: string;
  /** `[[` create-new row; `{{query}}` is replaced with the typed title. */
  wikiCreateNew: string;
  /** Shown inside a `![[embed]]` while its target is being resolved. */
  embedLoading: string;
  /** Shown inside a `![[embed]]` when the target note does not exist. */
  embedMissing: string;
  /** Shown inside a `![[Note#Section]]` embed when the section isn't found. */
  embedSectionMissing: string;
  /** Affordance to open the embedded note. */
  embedOpenNote: string;
  /** Shown inside a `((^id))` reference chip while it is being resolved. */
  blockRefLoading: string;
  /** Shown inside a `((^id))` reference chip when the block no longer exists. */
  blockRefMissing: string;
  /** Tooltip on a kept AI-rewrite change (clicking rejects it). */
  suggestReject: string;
  /** Tooltip on a rejected AI-rewrite change (clicking restores it). */
  suggestRestore: string;
}

const DEFAULT_LABELS: NovalisEditorLabels = {
  placeholder: "Start writing…",
  bold: "Bold",
  italic: "Italic",
  heading1: "Heading 1",
  heading2: "Heading 2",
  bulletList: "List",
  taskList: "Tasks",
  codeBlock: "Code",
  blockquote: "Quote",
  heading3: "Heading 3",
  strike: "Strikethrough",
  horizontalRule: "Horizontal rule",
  callout: "Callout",
  mermaidShowSource: "Show source",
  mermaidShowDiagram: "Show diagram",
  slashMath: "Math block",
  slashMermaid: "Mermaid diagram",
  wikiCreateNew: 'Create "{{query}}"',
  embedLoading: "Loading…",
  embedMissing: "Note not found",
  embedSectionMissing: "Section not found",
  embedOpenNote: "Open note",
  blockRefLoading: "…",
  blockRefMissing: "Block not found",
  suggestReject: "Reject this change",
  suggestRestore: "Restore this change",
};

/** Serialize the editor's current doc to markdown (the canonical serializer —
 *  hosts use this to snapshot a live editor instead of waiting on the
 *  debounced onChange). */
export function getMarkdown(editor: Editor): string {
  return (editor.storage.markdown as { getMarkdown(): string }).getMarkdown();
}

/** Options consumed by the extension stack itself — the subset of
 *  NovalisEditorProps that affects extensions rather than the React shell. */
export interface EditorExtensionsOptions {
  labels?: Partial<NovalisEditorLabels>;
  placeholder?: string;
  resolveImageSrc?: (src: string) => string;
  onWikiLinkClick?: (title: string) => void;
  onWikiLinkHover?: (title: string, rect: DOMRect) => void;
  onWikiLinkHoverEnd?: () => void;
  onResolveEmbed?: (target: string) => Promise<EmbedResult>;
  onOpenNote?: (target: string) => void;
  renderNote?: (body: string, mount: HTMLElement) => (() => void) | void;
  embedDepth?: number;
  onSearchLinkTargets?: (query: string) => Promise<{ title: string; path: string }[]>;
  onSearchTags?: (query: string) => Promise<string[]>;
  onSearchBlocks?: (query: string) => Promise<BlockCandidate[]>;
  onResolveBlock?: (id: string) => Promise<BlockRefResult>;
  onOpenBlock?: (notePath: string) => void;
}

/** The full extension stack. Exported (and used by the NovalisEditor component
 *  itself) so the markdown round-trip tests instantiate exactly the schema and
 *  serializers the app ships — the two can't drift. */
export function buildEditorExtensions(opts: EditorExtensionsOptions = {}): Extensions {
  const lbl = { ...DEFAULT_LABELS, ...opts.labels };
  const resolveImageSrc = opts.resolveImageSrc;

  // Image node that stores the relative `src` (for markdown round-trip) but
  // renders a resolved URL so the webview can display vault images.
  const VaultImage = Image.extend({
    renderHTML({ HTMLAttributes }) {
      const attrs = { ...HTMLAttributes };
      if (typeof attrs.src === "string" && resolveImageSrc) {
        attrs.src = resolveImageSrc(attrs.src);
      }
      return ["img", mergeAttributes(attrs)];
    },
  });

  return [
    // Disable StarterKit's plain code block; CodeBlockLowlight replaces it
    // (same `codeBlock` node name + `language` attr, so Markdown round-trip
    // via tiptap-markdown is unchanged). Its Text node is disabled too;
    // MarkdownText below replaces it (same `text` node, plus a serializer
    // that doesn't corrupt wikilinks/math/`<`/`>` on save).
    StarterKit.configure({ codeBlock: false, text: false }),
    MarkdownText,
    MermaidCodeBlock.configure({
      lowlight,
      mermaidShowSource: lbl.mermaidShowSource,
      mermaidShowDiagram: lbl.mermaidShowDiagram,
    }),
    Markdown.configure({
      html: false,
      linkify: true,
      transformPastedText: true,
      transformCopiedText: true,
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    // GFM tables. Without these nodes a `| a | b |` table is flattened to
    // plain paragraph text on the first edit (markdown-it parses it into a
    // <table> the schema had nowhere to put). tiptap-markdown ships a
    // pipe-table serializer keyed to these standard node names.
    Table,
    TableRow,
    TableHeader,
    TableCell,
    Link.configure({ openOnClick: false, autolink: true }),
    VaultImage,
    Placeholder.configure({ placeholder: opts.placeholder ?? lbl.placeholder }),
    WikiLink.configure({
      onClick: opts.onWikiLinkClick,
      onHover: opts.onWikiLinkHover,
      onHoverEnd: opts.onWikiLinkHoverEnd,
    }),
    // Register transclusion only below the depth cap; at/above it the inner
    // `![[…]]` of a maximally-nested embed renders as inert literal text.
    ...((opts.embedDepth ?? 0) < MAX_EMBED_DEPTH
      ? [
          Embed.configure({
            onResolve: opts.onResolveEmbed,
            onOpenNote: opts.onOpenNote,
            renderNote: opts.renderNote,
            labels: {
              loading: lbl.embedLoading,
              missing: lbl.embedMissing,
              sectionMissing: lbl.embedSectionMissing,
              openNote: lbl.embedOpenNote,
            },
          }),
        ]
      : []),
    WikiLinkSuggestion.configure({
      onSearch: opts.onSearchLinkTargets,
      createLabel: lbl.wikiCreateNew,
    }),
    TagSuggestion.configure({ onSearch: opts.onSearchTags }),
    // First-class block references: render `((^id))` inline + dim ` ^id`
    // markers; `((` autocomplete over the block index. Both are plain-text
    // constructs (no custom node), so the markdown round-trip stays trivial.
    BlockRef.configure({
      onResolve: opts.onResolveBlock,
      onOpen: opts.onOpenBlock,
      labels: { loading: lbl.blockRefLoading, missing: lbl.blockRefMissing },
    }),
    BlockRefSuggestion.configure({ onSearch: opts.onSearchBlocks }),
    SlashCommand.configure({
      labels: {
        heading1: lbl.heading1,
        heading2: lbl.heading2,
        heading3: lbl.heading3,
        bulletList: lbl.bulletList,
        taskList: lbl.taskList,
        codeBlock: lbl.codeBlock,
        blockquote: lbl.blockquote,
        callout: lbl.callout,
        horizontalRule: lbl.horizontalRule,
        math: lbl.slashMath,
        mermaid: lbl.slashMermaid,
      },
    }),
    Find,
    SuggestRewrite.configure({
      labels: { reject: lbl.suggestReject, restore: lbl.suggestRestore },
    }),
    Callout,
    MathExtension,
  ];
}

export function NovalisEditor({
  value,
  onChange,
  editable = true,
  placeholder,
  onUploadImage,
  resolveImageSrc,
  onWikiLinkClick,
  onResolveEmbed,
  onOpenNote,
  embedDepth,
  onSearchLinkTargets,
  onSearchTags,
  onSearchBlocks,
  onResolveBlock,
  onOpenBlock,
  onWikiLinkHover,
  onWikiLinkHoverEnd,
  onEditorReady,
  onFindToggle,
  serializeMs,
  spellCheck,
  labels,
}: NovalisEditorProps) {
  const lbl = { ...DEFAULT_LABELS, ...labels };
  // Latest onChange, without re-creating the editor when it changes.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Latest serialize debounce, read at flush time so changes apply live.
  const serializeMsRef = useRef(serializeMs ?? 200);
  serializeMsRef.current = serializeMs ?? 200;
  const onEditorReadyRef = useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;
  const onFindToggleRef = useRef(onFindToggle);
  onFindToggleRef.current = onFindToggle;
  // Debounce full-document markdown serialization. `getMarkdown` walks and
  // serializes the entire document; doing it on every keystroke is the main
  // typing lag on large notes. Serialize at most every ~200ms and flush on
  // blur/unmount so the host still gets the latest content before it saves.
  const serializeTimer = useRef<number | null>(null);

  const insertUploaded = (view: EditorView, file: File) => {
    if (!onUploadImage) return;
    void onUploadImage(file).then((rel) => {
      if (!rel) return;
      const node = view.state.schema.nodes.image.create({ src: rel });
      view.dispatch(view.state.tr.replaceSelectionWith(node));
    });
  };

  const firstImage = (files: FileList | undefined | null) =>
    Array.from(files ?? []).find((f) => f.type.startsWith("image/"));

  // Render a transcluded note body read-only into the Embed widget's mount. A
  // nested NovalisEditor gives embedded math/mermaid/callouts/wikilinks the same
  // rendering as the source; `embedDepth + 1` plus the MAX_EMBED_DEPTH guard on
  // the extension below terminate recursion. `onChange`/`onEditorReady`/
  // `onFindToggle` are intentionally NOT forwarded — the nested editor is
  // read-only and must not hijack the host's outline, save, or Cmd/Ctrl+F.
  // Returns the unmount fn the Embed extension calls on widget teardown.
  const depth = embedDepth ?? 0;
  const renderNote = (body: string, mount: HTMLElement): (() => void) => {
    const root = createRoot(mount);
    root.render(
      <NovalisEditor
        value={body}
        editable={false}
        embedDepth={depth + 1}
        resolveImageSrc={resolveImageSrc}
        onWikiLinkClick={onWikiLinkClick}
        onResolveEmbed={onResolveEmbed}
        onOpenNote={onOpenNote}
        onResolveBlock={onResolveBlock}
        onOpenBlock={onOpenBlock}
        labels={lbl}
      />,
    );
    return () => root.unmount();
  };

  const editor = useEditor({
    editable,
    extensions: buildEditorExtensions({
      labels: lbl,
      placeholder,
      resolveImageSrc,
      onWikiLinkClick,
      onWikiLinkHover,
      onWikiLinkHoverEnd,
      onResolveEmbed,
      onOpenNote,
      renderNote,
      embedDepth: depth,
      onSearchLinkTargets,
      onSearchTags,
      onSearchBlocks,
      onResolveBlock,
      onOpenBlock,
    }),
    content: value,
    onUpdate: ({ editor }) => {
      if (!onChangeRef.current) return;
      if (serializeTimer.current) window.clearTimeout(serializeTimer.current);
      serializeTimer.current = window.setTimeout(() => {
        serializeTimer.current = null;
        onChangeRef.current?.(getMarkdown(editor));
      }, serializeMsRef.current);
    },
    editorProps: {
      handleKeyDown(_view, event) {
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "f") {
          event.preventDefault();
          onFindToggleRef.current?.();
          return true;
        }
        return false;
      },
      handlePaste(view, event) {
        const file = firstImage(event.clipboardData?.files);
        if (!file || !onUploadImage) return false;
        event.preventDefault();
        insertUploaded(view, file);
        return true;
      },
      handleDrop(view, event) {
        const file = firstImage(event.dataTransfer?.files);
        if (!file || !onUploadImage) return false;
        event.preventDefault();
        insertUploaded(view, file);
        return true;
      },
    },
  });

  // Flush any pending serialization on blur and on unmount (e.g. switching
  // notes) so the latest edits reach the host before it persists them.
  useEffect(() => {
    if (!editor) return;
    const flush = () => {
      if (serializeTimer.current === null) return;
      window.clearTimeout(serializeTimer.current);
      serializeTimer.current = null;
      onChangeRef.current?.(getMarkdown(editor));
    };
    editor.on("blur", flush);
    return () => {
      editor.off("blur", flush);
      flush();
    };
  }, [editor]);

  // Reflect the spellcheck preference on the contenteditable, live.
  useEffect(() => {
    if (editor) editor.view.dom.setAttribute("spellcheck", String(spellCheck ?? true));
  }, [editor, spellCheck]);

  // `editable` is consumed at creation by useEditor; reflect later changes live
  // so toggling reading mode doesn't require a remount (which would lose the
  // cursor/scroll position). emitUpdate=false: toggling editability is not a
  // content change — the default `update` emission would arm the serialize
  // debounce (and host dirty-tracking) for a doc that didn't change.
  useEffect(() => {
    if (editor) editor.setEditable(editable, false);
  }, [editor, editable]);

  // Hand the editor instance to the host once it exists (outline / find/replace).
  useEffect(() => {
    if (editor) onEditorReadyRef.current?.(editor);
  }, [editor]);

  if (!editor) return null;

  return (
    <div className={`nv-editor${editable ? "" : " nv-reading"}`}>
      {editable && <Toolbar editor={editor} labels={lbl} />}
      <EditorContent editor={editor} className="nv-editor-content" />
    </div>
  );
}

function Toolbar({ editor, labels }: { editor: Editor; labels: NovalisEditorLabels }) {
  const Btn = ({
    glyph,
    title,
    onClick,
    active = false,
  }: {
    glyph: string;
    title: string;
    onClick: () => void;
    active?: boolean;
  }) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={`nv-tb-btn${active ? " is-active" : ""}`}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
    >
      {glyph}
    </button>
  );

  return (
    <div className="nv-toolbar">
      <Btn glyph="B" title={labels.bold} onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} />
      <Btn glyph="I" title={labels.italic} onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} />
      <Btn glyph={"S̶"} title={labels.strike} onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive("strike")} />
      <Btn glyph="H1" title={labels.heading1} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive("heading", { level: 1 })} />
      <Btn glyph="H2" title={labels.heading2} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })} />
      <Btn glyph="H3" title={labels.heading3} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive("heading", { level: 3 })} />
      <Btn glyph={labels.bulletList} title={labels.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} />
      <Btn glyph={labels.taskList} title={labels.taskList} onClick={() => editor.chain().focus().toggleTaskList().run()} active={editor.isActive("taskList")} />
      <Btn glyph={labels.codeBlock} title={labels.codeBlock} onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive("codeBlock")} />
      <Btn glyph={labels.blockquote} title={labels.blockquote} onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive("blockquote")} />
      <Btn
        glyph={labels.callout}
        title={labels.callout}
        onClick={() => {
          const c = editor.chain().focus();
          if (!editor.isActive("blockquote")) c.toggleBlockquote();
          c.insertContent("[!NOTE] ").run();
        }}
      />
      <Btn glyph="—" title={labels.horizontalRule} onClick={() => editor.chain().focus().setHorizontalRule().run()} />
    </div>
  );
}
