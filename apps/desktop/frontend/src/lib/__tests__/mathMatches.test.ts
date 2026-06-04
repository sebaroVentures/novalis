import { describe, expect, it } from "vitest";

import { findMath } from "@novalis/editor";

describe("findMath", () => {
  it("finds inline math", () => {
    expect(findMath("a $x^2$ b")).toEqual([{ from: 2, to: 7, content: "x^2", display: false }]);
  });

  it("finds block math", () => {
    expect(findMath("$$E=mc^2$$")).toEqual([{ from: 0, to: 10, content: "E=mc^2", display: true }]);
  });

  it("finds multiple inline spans", () => {
    expect(findMath("$a$ and $b$").map((m) => m.content)).toEqual(["a", "b"]);
  });

  it("ignores currency-like text with spaces", () => {
    expect(findMath("$5 and $10")).toEqual([]);
  });

  it("requires non-space just inside the delimiters", () => {
    expect(findMath("$ x $")).toEqual([]);
  });
});
