import { describe, expect, it } from "vitest";

import { parseCallout } from "@novalis/editor";

describe("parseCallout", () => {
  it("parses a known type with a title", () => {
    expect(parseCallout("[!NOTE] Remember this")).toEqual({ type: "note", title: "Remember this" });
  });

  it("lowercases the type and tolerates no title", () => {
    expect(parseCallout("[!WARNING]")).toEqual({ type: "warning", title: "" });
  });

  it("falls back to note for unknown types", () => {
    expect(parseCallout("[!frobnicate] x")).toEqual({ type: "note", title: "x" });
  });

  it("tolerates leading whitespace", () => {
    expect(parseCallout("  [!tip] go")).toEqual({ type: "tip", title: "go" });
  });

  it("returns null for a plain blockquote", () => {
    expect(parseCallout("just a quote")).toBeNull();
  });
});
