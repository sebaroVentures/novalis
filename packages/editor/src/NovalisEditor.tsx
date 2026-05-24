import { EditorContent, type Editor, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "tiptap-markdown";

export interface NovalisEditorProps {
  /** Initial markdown content. Treated as the starting value; remount (via a
   *  React `key`) to load a different note. */
  value: string;
  /** Called with the full markdown on every edit. */
  onChange?: (markdown: string) => void;
  editable?: boolean;
  placeholder?: string;
}

function getMarkdown(editor: Editor): string {
  return (editor.storage.markdown as { getMarkdown(): string }).getMarkdown();
}

export function NovalisEditor({
  value,
  onChange,
  editable = true,
  placeholder,
}: NovalisEditorProps) {
  const editor = useEditor({
    editable,
    extensions: [
      StarterKit,
      Markdown.configure({
        html: false,
        linkify: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({ placeholder: placeholder ?? "Start writing…" }),
    ],
    content: value,
    onUpdate: ({ editor }) => onChange?.(getMarkdown(editor)),
  });

  if (!editor) return null;

  return (
    <div className="nv-editor">
      {editable && <Toolbar editor={editor} />}
      <EditorContent editor={editor} className="nv-editor-content" />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const Btn = ({
    label,
    onClick,
    active = false,
  }: {
    label: string;
    onClick: () => void;
    active?: boolean;
  }) => (
    <button
      type="button"
      className={`nv-tb-btn${active ? " is-active" : ""}`}
      // mousedown + preventDefault keeps the editor selection.
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="nv-toolbar">
      <Btn label="B" onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} />
      <Btn label="I" onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} />
      <Btn label="H1" onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive("heading", { level: 1 })} />
      <Btn label="H2" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive("heading", { level: 2 })} />
      <Btn label="List" onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} />
      <Btn label="Tasks" onClick={() => editor.chain().focus().toggleTaskList().run()} active={editor.isActive("taskList")} />
      <Btn label="Code" onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive("codeBlock")} />
      <Btn label="Quote" onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive("blockquote")} />
    </div>
  );
}
