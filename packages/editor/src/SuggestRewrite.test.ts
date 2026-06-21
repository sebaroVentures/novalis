import { describe, expect, it } from "vitest";

import { computeRewrite, wordDiff, type Hunk } from "./SuggestRewrite";

describe("wordDiff", () => {
  it("returns a single eq span for identical text", () => {
    expect(wordDiff("hello world", "hello world")).toEqual([{ type: "eq", text: "hello world" }]);
  });

  it("captures a one-word replacement as del + ins", () => {
    const ops = wordDiff("the quick fox", "the slow fox");
    expect(ops.map((o) => o.type)).toEqual(["eq", "del", "ins", "eq"]);
    // A word carries its trailing space, so the swapped token includes it.
    expect(ops.find((o) => o.type === "del")?.text).toBe("quick ");
    expect(ops.find((o) => o.type === "ins")?.text).toBe("slow ");
  });

  it("coalesces adjacent changes of the same type", () => {
    const ops = wordDiff("a b c", "a x y z c");
    // "b" deleted, "x y z" inserted — the inserts must be one span, not three.
    const ins = ops.filter((o) => o.type === "ins");
    expect(ins).toHaveLength(1);
    expect(ins[0].text).toContain("x");
    expect(ins[0].text).toContain("z");
  });

  it("handles pure insertion and pure deletion", () => {
    expect(wordDiff("", "hello").filter((o) => o.type === "ins")).toHaveLength(1);
    expect(wordDiff("hello", "").filter((o) => o.type === "del")).toHaveLength(1);
  });
});

describe("computeRewrite", () => {
  // A clean single-block selection: positions map linearly from `from`.
  it("produces inline hunks with absolute positions", () => {
    const orig = "the quick fox";
    const from = 5; // pretend the selection starts at doc pos 5
    const to = from + orig.length;
    const plan = computeRewrite(from, to, orig, "the slow fox");
    expect(plan.mode).toBe("inline");
    const del = plan.hunks.find((h) => h.kind === "del") as Hunk;
    const ins = plan.hunks.find((h) => h.kind === "ins") as Hunk;
    // "quick " (with its trailing space) sits at offset 4 within the selection.
    expect(del.from).toBe(from + 4);
    expect(del.to).toBe(from + 4 + "quick ".length);
    expect(del.text).toBe("quick ");
    // The insertion is anchored right after the deleted word (zero width).
    expect(ins.from).toBe(ins.to);
    expect(ins.from).toBe(del.to);
    // del + ins of the same replacement share a group.
    expect(ins.group).toBe(del.group);
  });

  it("groups separate edits independently", () => {
    const orig = "one two three four";
    const from = 0;
    const plan = computeRewrite(from, from + orig.length, orig, "one TWO three FOUR");
    expect(plan.groups.length).toBe(2);
  });

  it("falls back to block mode when positions are not linear (crossed blocks)", () => {
    const orig = "para one\npara two"; // a "\n" separator costs >1 doc position
    const from = 0;
    const to = 100; // to - from !== origText.length → not a clean text run
    const plan = computeRewrite(from, to, orig, "rewritten");
    expect(plan.mode).toBe("block");
    expect(plan.groups).toEqual([0]);
    expect(plan.hunks.find((h) => h.kind === "ins")?.text).toBe("rewritten");
  });

  it("emits no change hunks when the proposal equals the original", () => {
    const orig = "unchanged text";
    const plan = computeRewrite(0, orig.length, orig, "unchanged text");
    expect(plan.hunks).toHaveLength(0);
    expect(plan.groups).toHaveLength(0);
  });
});
