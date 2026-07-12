import { describe, expect, it } from "vitest";

import { parseAnswer } from "../citations";

describe("parseAnswer", () => {
  it("splits text and single citations in order", () => {
    const segs = parseAnswer("The launch is Friday [[1]] per the plan.");
    expect(segs).toEqual([
      { kind: "text", text: "The launch is Friday " },
      { kind: "citation", id: 1 },
      { kind: "text", text: " per the plan." },
    ]);
  });

  it("handles consecutive citations with no text between", () => {
    const segs = parseAnswer("Both agree [[1]][[2]].");
    expect(segs).toEqual([
      { kind: "text", text: "Both agree " },
      { kind: "citation", id: 1 },
      { kind: "citation", id: 2 },
      { kind: "text", text: "." },
    ]);
  });

  it("parses a leading citation and multi-digit ids", () => {
    const segs = parseAnswer("[[12]] leads.");
    expect(segs).toEqual([
      { kind: "citation", id: 12 },
      { kind: "text", text: " leads." },
    ]);
  });

  it("returns a single text segment when there are no citations", () => {
    expect(parseAnswer("plain answer")).toEqual([{ kind: "text", text: "plain answer" }]);
  });

  it("returns nothing for an empty string", () => {
    expect(parseAnswer("")).toEqual([]);
  });

  it("leaves malformed tokens as plain text", () => {
    // Not the exact [[n]] form → not a citation.
    expect(parseAnswer("see [[a]] and [ [1] ]")).toEqual([
      { kind: "text", text: "see [[a]] and [ [1] ]" },
    ]);
  });
});
