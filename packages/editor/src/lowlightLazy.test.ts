// @vitest-environment jsdom
//
// Syntax highlighting used to ship all ~37 highlight.js grammars in the eager
// bundle (`createLowlight(common)` at module scope). It now starts from an
// empty registry and lazy-loads the grammars the first time a code block
// appears. These tests pin the two things that must stay true through that
// change: an unregistered language degrades to a plain code block (no throw),
// and once the grammars load a fenced block actually highlights.

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { ensureHighlightGrammars, highlightGrammarsLoaded, lowlight } from "./lowlightLazy";
import { buildEditorExtensions } from "./NovalisEditor";

const editors: Editor[] = [];
const mounts: HTMLElement[] = [];

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
  while (mounts.length) mounts.pop()?.remove();
});

function mountEditor(content: string): { editor: Editor; element: HTMLElement } {
  const element = document.createElement("div");
  document.body.appendChild(element);
  mounts.push(element);
  const editor = new Editor({ element, extensions: buildEditorExtensions(), content });
  editors.push(editor);
  return { editor, element };
}

describe("lazy syntax highlighting", () => {
  it("never throws while grammars are unregistered and renders a plain code block", () => {
    // The empty registry means `highlightAuto` runs over zero languages: the
    // code block must render as text, not blow up the ProseMirror plugin.
    const { element } = mountEditor("```ts\nconst x: number = 1;\n```");
    expect(element.querySelector("pre code")).not.toBeNull();
  });

  it("registers the common grammar set (incl. aliases) after ensureHighlightGrammars", async () => {
    await ensureHighlightGrammars();
    expect(highlightGrammarsLoaded()).toBe(true);
    expect(lowlight.listLanguages()).toContain("typescript");
    // `ts` is a highlight.js alias for `typescript` — alias resolution must
    // survive the empty-registry-then-register path.
    expect(lowlight.registered("ts")).toBe(true);
  });

  it("highlights a fenced code block once the grammars load", async () => {
    const { element } = mountEditor("```ts\nconst x: number = 1;\n```");
    await ensureHighlightGrammars();
    // The plugin repaints on a microtask after registration; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const highlighted = element.querySelectorAll('[class*="hljs-"]');
    expect(highlighted.length).toBeGreaterThan(0);
  });
});
