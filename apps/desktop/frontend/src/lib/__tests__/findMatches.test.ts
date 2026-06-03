import { describe, expect, it } from "vitest";

import { findMatches } from "@novalis/editor";

describe("findMatches", () => {
  it("returns nothing for an empty query", () => {
    expect(findMatches("hello world", "", false)).toEqual([]);
  });

  it("finds non-overlapping matches", () => {
    expect(findMatches("aaaa", "aa", true)).toEqual([0, 2]);
  });

  it("is case-insensitive when the flag is false", () => {
    expect(findMatches("Hello hello HELLO", "hello", false)).toEqual([0, 6, 12]);
  });

  it("respects case sensitivity", () => {
    expect(findMatches("Hello hello", "hello", true)).toEqual([6]);
  });

  it("returns no matches when the query is absent", () => {
    expect(findMatches("abc", "xyz", false)).toEqual([]);
  });
});
