import { describe, expect, it } from "vitest";

import { findBlockId, findBlockRefs, newBlockId } from "./blockRefMatches";

describe("findBlockRefs", () => {
  it("finds a `((^id))` reference with its span and id", () => {
    expect(findBlockRefs("see ((^k3f9qz)) here")).toEqual([
      { from: 4, to: 15, id: "k3f9qz" },
    ]);
  });

  it("finds multiple references in order", () => {
    const refs = findBlockRefs("((^aaa111)) and ((^bbb222))");
    expect(refs.map((r) => r.id)).toEqual(["aaa111", "bbb222"]);
  });

  it("ignores ordinary parenthetical prose (no caret sigil)", () => {
    expect(findBlockRefs("a note ((hello)) and ((see below))")).toEqual([]);
  });

  it("requires base36 ids (rejects spaces/uppercase inside)", () => {
    expect(findBlockRefs("((^Not Valid)) ((^UPPER))")).toEqual([]);
  });
});

describe("findBlockId", () => {
  it("finds a trailing ` ^id` marker after content", () => {
    expect(findBlockId("A key point. ^k3f9qz")).toEqual({
      from: 12,
      to: 20,
      id: "k3f9qz",
    });
  });

  it("returns null when there is no marker", () => {
    expect(findBlockId("just some prose")).toBeNull();
  });

  it("does not mistake a mid-text caret (e.g. math) for a marker", () => {
    // `e^{i}` has no space before the caret, and the marker must be trailing.
    expect(findBlockId("Euler $e^{i}$ prose")).toBeNull();
  });

  it("only matches the trailing marker, not an earlier caret", () => {
    expect(findBlockId("x ^abcd is text but ^real01")).toEqual({
      from: 19,
      to: 27,
      id: "real01",
    });
  });
});

describe("newBlockId", () => {
  it("produces a 6-char base36 id", () => {
    for (let i = 0; i < 50; i++) {
      expect(newBlockId()).toMatch(/^[a-z0-9]{6}$/);
    }
  });
});
