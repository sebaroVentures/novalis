import { useEffect, useRef } from "react";
import { mergeAttributes } from "@tiptap/core";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, type Editor, useEditor } from "@tiptap/react";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { common, createLowlight } from "lowlight";
import { Markdown } from "tiptap-markdown";

import { Callout } from "./Callout";
import { Find } from "./Find";
import { MathExtension } from "./Math";
import { WikiLink } from "./WikiLink";
import { WikiLinkSuggestion } from "./WikiLinkSuggestion";

// Shared lowlight registry (highlight.js "common" set, ~37 languages), created
// once at module scope so the language registry is stable across editor mounts.
const lowlight = createLowlight(common);

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
  /** Search note titles for the `[[` autocomplete. Host wires it to its index;
   *  results are shown in a popover and inserted as plain `[[Title]]` text. */
  onSearchLinkTargets?: (query: string) => Promise<{ title: string; path: string }[]>;
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
};

function getMarkdown(editor: Editor): string {
  return (editor.storage.markdown as { getMarkdown(): string }).getMarkdown();
}

export function NovalisEditor({
  value,
  onChange,
  editable = true,
  placeholder,
  onUploadImage,
  resolveImageSrc,
  onWikiLinkClick,
  onSearchLinkTargets,
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

  const editor = useEditor({
    editable,
    extensions: [
      // Disable StarterKit's plain code block; CodeBlockLowlight replaces it
      // (same `codeBlock` node name + `language` attr, so Markdown round-trip
      // via tiptap-markdown is unchanged).
      StarterKit.configure({ codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight }),
      Markdown.configure({
        html: false,
        linkify: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false, autolink: true }),
      VaultImage,
      Placeholder.configure({ placeholder: placeholder ?? lbl.placeholder }),
      WikiLink.configure({
        onClick: onWikiLinkClick,
        onHover: onWikiLinkHover,
        onHoverEnd: onWikiLinkHoverEnd,
      }),
      WikiLinkSuggestion.configure({ onSearch: onSearchLinkTargets }),
      Find,
      Callout,
      MathExtension,
    ],
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

  // Hand the editor instance to the host once it exists (outline / find/replace).
  useEffect(() => {
    if (editor) onEditorReadyRef.current?.(editor);
  }, [editor]);

  if (!editor) return null;

  return (
    <div className="nv-editor">
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
