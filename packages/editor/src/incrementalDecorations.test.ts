// @vitest-environment jsdom
//
// The WikiLink and Callout plugins no longer discard and rebuild their whole
// DecorationSet on every keystroke — they map the existing set through the
// transaction and re-scan only the blocks that changed. That is only a win if
// the incremental result is *identical* to a from-scratch full rebuild, so
// these tests apply representative edit sequences and assert exactly that after
// every step, against the live extension stack the app ships.

import { Editor } from "@tiptap/core";
import type { PluginKey } from "@tiptap/pm/state";
import type { DecorationSet } from "@tiptap/pm/view";
import { afterEach, describe, expect, it } from "vitest";

import { calloutKey } from "./Callout";
import { buildEditorExtensions } from "./NovalisEditor";
import { wikiLinkKey } from "./WikiLink";

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

function createEditor(content: string): Editor {
  const editor = new Editor({ extensions: buildEditorExtensions(), content });
  editors.push(editor);
  return editor;
}

interface DecoRepr {
  from: number;
  to: number;
  attrs: string;
}

/** Order-independent, position-keyed view of a DecorationSet's contents,
 *  capturing each decoration's span and its attributes (class + data-*). */
function reprSet(set: DecorationSet | undefined): DecoRepr[] {
  if (!set) return [];
  return set
    .find()
    .map((d) => ({
      from: d.from,
      to: d.to,
      // `type.attrs` is where inline/node decorations stash their class + data
      // attributes; it's internal (not in the .d.ts) but stable, and this is a
      // test-only read.
      attrs: JSON.stringify((d as unknown as { type?: { attrs?: unknown } }).type?.attrs ?? {}),
    }))
    .sort((a, b) => a.from - b.from || a.to - b.to || a.attrs.localeCompare(b.attrs));
}

/** A from-scratch full rebuild: a fresh editor over the identical document
 *  (ProseMirror JSON round-trips exactly) runs each plugin's `init`, i.e. a
 *  whole-doc scan. That is the reference the incremental set must equal. */
function fullRebuild(editor: Editor, key: PluginKey): DecoRepr[] {
  const ref = new Editor({ extensions: buildEditorExtensions(), content: editor.getJSON() });
  editors.push(ref);
  return reprSet(key.getState(ref.state) as DecorationSet);
}

function assertIncrementalMatchesFull(editor: Editor, msg: string): void {
  expect(reprSet(wikiLinkKey.getState(editor.state) as DecorationSet), `wikilink: ${msg}`).toEqual(
    fullRebuild(editor, wikiLinkKey),
  );
  expect(reprSet(calloutKey.getState(editor.state) as DecorationSet), `callout: ${msg}`).toEqual(
    fullRebuild(editor, calloutKey),
  );
}

/** Absolute position of the first occurrence of `needle` in the doc's text. */
function posOf(editor: Editor, needle: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.isText && node.text) {
      const idx = node.text.indexOf(needle);
      if (idx >= 0) {
        found = pos + idx;
        return false;
      }
    }
    return undefined;
  });
  if (found < 0) throw new Error(`needle not found: ${JSON.stringify(needle)}`);
  return found;
}

describe("incremental decorations equal a full rebuild", () => {
  it("insert in the middle of a wikilink", () => {
    const editor = createEditor("See [[Target]] here and [[Other]] too.");
    assertIncrementalMatchesFull(editor, "initial");
    const at = posOf(editor, "Target") + 3; // inside the title
    editor.commands.insertContentAt(at, "XY");
    assertIncrementalMatchesFull(editor, "after mid-link insert"); // now [[TarXYget]]
    // Break the link by deleting its opening bracket, then repair it.
    const openBracket = posOf(editor, "[[TarXYget");
    editor.commands.deleteRange({ from: openBracket, to: openBracket + 1 });
    assertIncrementalMatchesFull(editor, "after breaking a bracket"); // now [TarXYget]]
    editor.commands.insertContentAt(posOf(editor, "[TarXYget"), "[");
    assertIncrementalMatchesFull(editor, "after repairing the bracket");
  });

  it("delete across a link boundary", () => {
    const editor = createEditor("[[Alpha]] joins [[Beta]] across.");
    const from = posOf(editor, "]] joins") + 1; // just before the second `]`
    const to = posOf(editor, "[[Beta") + 3; // into the second link's title
    editor.commands.deleteRange({ from, to });
    assertIncrementalMatchesFull(editor, "after cross-boundary delete");
  });

  it("type a wikilink one character at a time", () => {
    const editor = createEditor("Prefix X suffix.");
    let caret = posOf(editor, "X suffix"); // just before the X
    for (const ch of "[[Note#Sec|alias]]".split("")) {
      editor.commands.insertContentAt(caret, ch);
      caret += ch.length;
      assertIncrementalMatchesFull(editor, `after typing ${JSON.stringify(ch)}`);
    }
  });

  it("split and rejoin a callout blockquote", () => {
    const editor = createEditor("> [!NOTE] First line then more text\n\nAfter.");
    assertIncrementalMatchesFull(editor, "initial callout");
    // Split the callout paragraph in two.
    const splitAt = posOf(editor, "then more");
    editor.commands.setTextSelection(splitAt);
    editor.commands.splitBlock();
    assertIncrementalMatchesFull(editor, "after split");
    // Rejoin by deleting the boundary from the start of the new block.
    editor.commands.joinBackward();
    assertIncrementalMatchesFull(editor, "after rejoin");
  });

  it("promote a plain blockquote to a callout and back", () => {
    const editor = createEditor("> plain quote\n\nBody paragraph.");
    assertIncrementalMatchesFull(editor, "plain blockquote");
    // Turn it into a callout by prefixing the marker.
    editor.commands.insertContentAt(posOf(editor, "plain quote"), "[!WARNING] ");
    assertIncrementalMatchesFull(editor, "after adding marker");
    // Remove the marker again.
    editor.commands.deleteRange({
      from: posOf(editor, "[!WARNING] "),
      to: posOf(editor, "[!WARNING] ") + "[!WARNING] ".length,
    });
    assertIncrementalMatchesFull(editor, "after removing marker");
  });

  it("type $math$ next to a link without disturbing its decorations", () => {
    const editor = createEditor("Link [[Ref]] and math here: x.");
    const caret = posOf(editor, "here: ") + "here: ".length;
    for (const ch of "$a^2$".split("")) {
      editor.commands.insertContentAt(caret, ch);
      assertIncrementalMatchesFull(editor, `after typing math ${JSON.stringify(ch)}`);
    }
  });

  it("delete a whole paragraph that contains a link and a callout above it", () => {
    const editor = createEditor("> [!TIP] tip text\n\nMiddle [[Link]] here.\n\nTail.");
    const from = posOf(editor, "Middle");
    const to = posOf(editor, "here.") + "here.".length;
    editor.commands.deleteRange({ from: from - 1, to: to + 1 });
    assertIncrementalMatchesFull(editor, "after deleting the middle paragraph");
  });

  it("edit a block far from any decoration leaves untouched ones intact", () => {
    const editor = createEditor(
      "[[Top]] link.\n\n" + "filler paragraph.\n\n".repeat(20) + "> [!NOTE] bottom callout",
    );
    assertIncrementalMatchesFull(editor, "initial large doc");
    editor.commands.insertContentAt(posOf(editor, "filler paragraph."), "EDIT ");
    assertIncrementalMatchesFull(editor, "after editing a middle filler paragraph");
  });
});
