// @vitest-environment jsdom
//
// Block-id insertion must be exactly round-trip stable: assigning an id writes
// a ` ^id` marker into the Markdown, and the very next save re-serializes the
// whole document — so a mangled or duplicated marker would corrupt the note on
// disk. These tests instantiate the exact extension stack the app ships
// (buildEditorExtensions) and pin the behavior.

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { assignBlockId } from "./BlockRef";
import { buildEditorExtensions } from "./NovalisEditor";

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

function createEditor(markdown: string): Editor {
  const editor = new Editor({ extensions: buildEditorExtensions(), content: markdown });
  editors.push(editor);
  return editor;
}

function serialize(editor: Editor): string {
  return (editor.storage.markdown as { getMarkdown(): string }).getMarkdown();
}

describe("assignBlockId", () => {
  it("tags the current block with a round-trip-safe marker", () => {
    const editor = createEditor("A claim to reference.");
    editor.commands.setTextSelection(2);
    const id = assignBlockId(editor);
    expect(id).toMatch(/^[a-z0-9]{6}$/);

    const out = serialize(editor);
    expect(out).toBe(`A claim to reference. ^${id}`);

    // The tagged note round-trips byte-equal — no corruption on the next save.
    expect(serialize(createEditor(out))).toBe(out);
  });

  it("is idempotent — a second call keeps the same id, no duplicate marker", () => {
    const editor = createEditor("Stable block.");
    editor.commands.setTextSelection(2);
    const id1 = assignBlockId(editor);
    const id2 = assignBlockId(editor);
    expect(id2).toBe(id1);
    expect((serialize(editor).match(/\^/g) ?? []).length).toBe(1);
  });

  it("survives an edit in a different block without mangling or duplicating", () => {
    const editor = createEditor("Tagged point. ^aaa111\n\nOther paragraph.");
    // Edit the trailing paragraph (a different block).
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent(" more");

    const out = serialize(editor);
    expect((out.match(/\^aaa111/g) ?? []).length).toBe(1);
    expect(out).toContain("Tagged point. ^aaa111");
    expect(out).toContain("Other paragraph. more");
  });

  it("never tags a code block", () => {
    const editor = createEditor("```\ncode\n```");
    editor.commands.setTextSelection(3);
    expect(assignBlockId(editor)).toBeNull();
  });
});
