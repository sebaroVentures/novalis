// @vitest-environment jsdom
//
// Golden-file round-trip corpus for markdown serialization. Every save
// re-serializes the whole document, so any escaping bug here silently rewrites
// notes on disk (the historical defect: `[[Note]]` → `\[\[Note\]\]`,
// `5 < 7` → `5 &lt; 7`, `$\frac{a}{b}$` → `$\\frac{a}{b}$`). These tests
// instantiate the exact extension stack the app ships (buildEditorExtensions)
// and pin the serialized output byte-for-byte:
//   - "byte-equal" fixtures must round-trip unchanged — regressions here mean
//     on-disk corruption;
//   - "documented normalization" fixtures pin the exact rewritten output, so
//     any future change to a normalization is a conscious decision, not an
//     accident.

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildEditorExtensions } from "./NovalisEditor";

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

function createEditor(markdown: string): Editor {
  const editor = new Editor({
    extensions: buildEditorExtensions(),
    content: markdown,
  });
  editors.push(editor);
  return editor;
}

function serialize(editor: Editor): string {
  return (editor.storage.markdown as { getMarkdown(): string }).getMarkdown();
}

/** Parse markdown into the editor, serialize it back out. */
function roundTrip(markdown: string): string {
  return serialize(createEditor(markdown));
}

describe("markdown round-trip: byte-equal", () => {
  const cases: [name: string, markdown: string][] = [
    ["wikilink", "Link to [[Meeting Notes]] here."],
    ["wikilink with heading anchor", "See [[Project Plan#Goals]]."],
    ["wikilink with alias", "See [[Meeting Notes|the notes]]."],
    ["embed", "![[Diagram.png]]"],
    ["embed with section anchor", "![[Design Doc#API]]"],
    ["inline math with backslash", "The rule $\\frac{a}{b}$ applies."],
    ["inline math with underscore and asterisk", "Sum $x_i * y$ done."],
    ["inline math exponents", "Euler: $e^{i\\pi} + 1 = 0$."],
    ["single-line block math", "$$\\sum_{i=0}^{n} x_i$$"],
    ["less-than in prose", "5 < 7 and 9 > 3"],
    ["angle brackets around identifier", "#include <vector>"],
    ["lone tilde", "a ~ b"],
    ["real strikethrough", "~~gone~~"],
    ["escaped tildes stay escaped", "\\~\\~not struck\\~\\~"],
    ["tags", "#foo/bar and #x"],
    ["task line", "- [ ] thing @due(2026-01-01)"],
    ["checked task line", "- [x] done thing"],
    ["inline code with less-than", "Use `a < b` here."],
    // Code fences are exempt from all of this (verbatim path) — pin it.
    ["code fence containing wikilink and math", "```text\n[[Not A Link]] and $not math$\n```"],
    ["real autolink", "<https://example.com>"],
    ["heading and tight list", "# Title\n\n- one\n- two"],
    ["single-line callout", "> [!NOTE] Remember this"],
    ["literal star-brackets already escaped", "\\*not bold\\* and \\[brackets\\]"],
    // Block references: the `((^id))` reference and the trailing ` ^id` marker
    // are plain base36 text — they must survive every save byte-for-byte, on a
    // paragraph, heading, and list item, and alongside other constructs.
    ["block reference", "See ((^k3f9qz)) for the argument."],
    ["block id marker on a paragraph", "An important claim. ^k3f9qz"],
    ["block id marker on a heading", "# Section Title ^head01"],
    ["block id marker on a list item", "- first item ^li0001"],
    ["reference next to a wikilink", "Per ((^k3f9qz)) and [[Meeting Notes]]."],
    ["marker on a line that also has math", "The rule $e^{i\\pi}$ holds. ^math01"],
  ];

  it.each(cases)("%s", (_name, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });
});

describe("markdown round-trip: documented normalizations", () => {
  const cases: [name: string, markdown: string, normalized: string][] = [
    // prosemirror-markdown escapes markdown punctuation in plain text; the
    // escape is un-done on reload, so the text is stable from the second save
    // on and renders identically everywhere.
    ["bare asterisk gains a backslash", "a * b literal", "a \\* b literal"],
    // markdown-it parses the outer `_…_` as emphasis; the emphasis mark
    // serializes with `*` delimiters (delimiter normalization, not data loss).
    ["underscore emphasis normalizes to asterisks", "_underscores_in_words_", "*underscores_in_words*"],
    // Soft line breaks inside a paragraph collapse to spaces (ProseMirror
    // whitespace handling on parse — pre-existing, independent of escaping).
    ["hard-wrapped paragraph joins lines", "line one\nline two", "line one line two"],
    // Same collapse applies inside multi-line `$$…$$` (the span survives, on
    // one line) and callout bodies.
    ["multi-line block math joins lines", "$$\nE = mc^2\n$$", "$$ E = mc^2 $$"],
    ["callout body joins the marker line", "> [!NOTE] Title\n> body text", "> [!NOTE] Title body text"],
    // linkify:true turns a bare URL into a link mark; prosemirror-markdown
    // serializes a plain link (text == href) in autolink form.
    ["bare URL becomes an autolink", "https://example.com", "<https://example.com>"],
    // markdown-it decodes entities on parse; with html:false nothing
    // re-encodes them (the decoded form round-trips stably afterwards).
    ["HTML entity is decoded", "5 &lt; 7", "5 < 7"],
    // linkify:true always re-links the URL text, so literal angle brackets
    // around a URL can't stay plain text. The document text is preserved
    // (`<https://example.com> is literal`); only the on-disk framing settles
    // into the `<<url>>` form (outer pair literal, inner pair autolink).
    [
      "escaped angle-bracket URL settles as literal-plus-autolink",
      "\\<https://example.com> is literal",
      "<<https://example.com>> is literal",
    ],
  ];

  it.each(cases)("%s", (_name, markdown, normalized) => {
    expect(roundTrip(markdown)).toBe(normalized);
    // Normalizations must be stable: a second round-trip changes nothing.
    expect(roundTrip(normalized)).toBe(normalized);
  });
});

describe("markdown serialization of typed (unparsed) text", () => {
  // Text typed in the GUI never went through markdown-it, so this is the exact
  // path that used to corrupt notes. Inserting a raw text node mimics typing.
  function typed(text: string): string {
    const editor = createEditor("");
    editor.commands.insertContentAt(1, { type: "text", text });
    return serialize(editor);
  }

  it("keeps wikilinks, embeds and math verbatim", () => {
    expect(typed("See [[Meeting Notes]] and ![[Diagram.png]] and $x_i * y$")).toBe(
      "See [[Meeting Notes]] and ![[Diagram.png]] and $x_i * y$",
    );
  });

  it("never entity-escapes angle brackets", () => {
    expect(typed("5 < 7 and #include <vector>")).toBe("5 < 7 and #include <vector>");
  });

  it("keeps lone tildes but escapes strikethrough runs", () => {
    expect(typed("a ~ b and ~~literal~~")).toBe("a ~ b and \\~\\~literal\\~\\~");
  });

  it("still escapes markdown punctuation in ordinary text", () => {
    expect(typed("*not bold* and [brackets]")).toBe("\\*not bold\\* and \\[brackets\\]");
  });

  it("guards a typed autolink-shaped run so reload keeps it literal", () => {
    expect(typed("see <https://example.com> here")).toBe("see \\<https://example.com> here");
    // Reloading the guarded form keeps the identical document text; on disk it
    // settles into the `<<url>>` framing (see the normalization corpus).
    expect(roundTrip("see \\<https://example.com> here")).toBe("see <<https://example.com>> here");
  });
});

describe("GFM tables", () => {
  // tiptap-markdown's table serializer always terminates the table with a
  // newline, so a note ENDING in a table carries a trailing "\n" (gained once,
  // then stable — the fixtures below include it).
  it("round-trips a pipe table byte-equal", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    expect(roundTrip(table)).toBe(table);
  });

  it("drops column alignment (documented normalization)", () => {
    // The schema's table cells carry no alignment attr, so `:---:` colons are
    // lost; the table itself survives.
    const aligned = "| a | b |\n| :--- | ---: |\n| 1 | 2 |\n";
    const normalized = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    expect(roundTrip(aligned)).toBe(normalized);
    expect(roundTrip(normalized)).toBe(normalized);
  });

  it("keeps wikilinks and math verbatim inside cells", () => {
    const table = "| link | math |\n| --- | --- |\n| [[Note]] | $x_i$ |\n";
    expect(roundTrip(table)).toBe(table);
  });
});
