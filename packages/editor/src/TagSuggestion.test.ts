import { describe, expect, it } from "vitest";

import { matchTagToken } from "./TagSuggestion";

describe("matchTagToken", () => {
  it("matches an ASCII tag at the start of a line", () => {
    expect(matchTagToken("#todo")).toEqual({ token: "#todo", query: "todo" });
  });

  it("matches after whitespace only", () => {
    expect(matchTagToken("see #todo")).toEqual({ token: "#todo", query: "todo" });
    expect(matchTagToken("see#todo")).toBeNull();
  });

  it("matches non-ASCII letters (German umlauts)", () => {
    expect(matchTagToken("#müll")).toEqual({ token: "#müll", query: "müll" });
  });

  it("matches accented letters with nesting", () => {
    expect(matchTagToken("#café/menu")).toEqual({ token: "#café/menu", query: "café/menu" });
  });

  it("keeps hyphens, underscores and digits", () => {
    expect(matchTagToken("#a-b_c2")).toEqual({ token: "#a-b_c2", query: "a-b_c2" });
  });

  it("matches a bare # (empty query) so the popover opens on the trigger", () => {
    expect(matchTagToken("x #")).toEqual({ token: "#", query: "" });
  });

  it("does not match once the token is broken by a space", () => {
    expect(matchTagToken("#müll ")).toBeNull();
  });
});
