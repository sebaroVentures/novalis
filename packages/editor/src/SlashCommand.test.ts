import { describe, expect, it } from "vitest";

import { buildItems, matchSlashToken, type SlashLabels } from "./SlashCommand";

describe("matchSlashToken", () => {
  it("matches a /query at the start of a line", () => {
    expect(matchSlashToken("/head")).toEqual({ token: "/head", query: "head" });
  });

  it("matches after whitespace only", () => {
    expect(matchSlashToken("text /code")).toEqual({ token: "/code", query: "code" });
    expect(matchSlashToken("a/b")).toBeNull();
  });

  it("matches non-ASCII letters instead of closing mid-word", () => {
    expect(matchSlashToken("/überschrift")).toEqual({
      token: "/überschrift",
      query: "überschrift",
    });
    expect(matchSlashToken("/matemáticas")).toEqual({
      token: "/matemáticas",
      query: "matemáticas",
    });
  });

  it("matches a bare / (empty query) so the menu opens on the trigger", () => {
    expect(matchSlashToken("x /")).toEqual({ token: "/", query: "" });
  });

  it("does not match once the token is broken by a space", () => {
    expect(matchSlashToken("/über ")).toBeNull();
  });
});

describe("buildItems feature filtering", () => {
  const labels: SlashLabels = {
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
  };
  const allOn = { math: true, mermaid: true, callout: true };
  const titles = (features: typeof allOn) => buildItems(labels, features).map((it) => it.title);

  it("includes math, mermaid and callout when all flags are on", () => {
    expect(titles(allOn)).toEqual(expect.arrayContaining(["Math block", "Mermaid diagram", "Callout"]));
  });

  it("drops exactly the flagged-off items, keeping everything else", () => {
    const off = titles({ math: false, mermaid: false, callout: false });
    expect(off).not.toContain("Math block");
    expect(off).not.toContain("Mermaid diagram");
    expect(off).not.toContain("Callout");
    expect(off).toHaveLength(titles(allOn).length - 3);
    expect(off).toEqual(
      expect.arrayContaining(["Heading 1", "Heading 2", "Heading 3", "List", "Tasks", "Code", "Quote", "Horizontal rule"]),
    );
  });

  it("filters each flag independently", () => {
    const noMath = titles({ ...allOn, math: false });
    expect(noMath).not.toContain("Math block");
    expect(noMath).toEqual(expect.arrayContaining(["Mermaid diagram", "Callout"]));

    const noMermaid = titles({ ...allOn, mermaid: false });
    expect(noMermaid).not.toContain("Mermaid diagram");
    expect(noMermaid).toEqual(expect.arrayContaining(["Math block", "Callout"]));

    const noCallout = titles({ ...allOn, callout: false });
    expect(noCallout).not.toContain("Callout");
    expect(noCallout).toEqual(expect.arrayContaining(["Math block", "Mermaid diagram"]));
  });
});
