import { describe, expect, it } from "vitest";

import {
  anchorPoint,
  autoSides,
  type CanvasData,
  emptyCanvas,
  genId,
  makeEdge,
  makeFileNode,
  makeTextNode,
  parseCanvas,
  resolveColor,
  serializeCanvas,
} from "../canvas";

describe("parseCanvas", () => {
  it("returns an empty canvas for empty / invalid / non-object JSON", () => {
    expect(parseCanvas("")).toEqual(emptyCanvas());
    expect(parseCanvas("not json")).toEqual(emptyCanvas());
    expect(parseCanvas("null")).toEqual(emptyCanvas());
    expect(parseCanvas("42")).toEqual(emptyCanvas());
    expect(parseCanvas("{}")).toEqual(emptyCanvas());
  });

  it("preserves unknown node/edge fields for a byte-faithful round trip", () => {
    const original: CanvasData = {
      nodes: [
        {
          id: "a",
          type: "file",
          x: 10,
          y: 20,
          width: 300,
          height: 220,
          file: "notes/x.md",
          color: "3",
          // A field the app does not model must survive untouched.
          styleAttributes: { shape: "pill" },
        },
        { id: "b", type: "text", x: 0, y: 0, width: 200, height: 100, text: "hi" },
      ],
      edges: [
        {
          id: "e1",
          fromNode: "a",
          toNode: "b",
          fromSide: "right",
          toSide: "left",
          label: "leads to",
          customEdgeField: true,
        },
      ],
    };
    const round = parseCanvas(serializeCanvas(original));
    expect(round).toEqual(original);
  });

  it("fills missing geometry with defaults and keeps other keys", () => {
    const parsed = parseCanvas(
      JSON.stringify({ nodes: [{ id: "a", type: "text", text: "hi" }], edges: [] }),
    );
    expect(parsed.nodes).toHaveLength(1);
    const n = parsed.nodes[0];
    expect(n.x).toBe(0);
    expect(n.y).toBe(0);
    expect(n.width).toBeGreaterThan(0);
    expect(n.height).toBeGreaterThan(0);
    expect(n.text).toBe("hi");
  });

  it("drops nodes/edges missing required identity fields", () => {
    const parsed = parseCanvas(
      JSON.stringify({
        nodes: [{ type: "text" }, { id: "ok", type: "text" }],
        edges: [{ id: "e", fromNode: "ok" }, { id: "e2", fromNode: "ok", toNode: "ok" }],
      }),
    );
    expect(parsed.nodes.map((n) => n.id)).toEqual(["ok"]);
    expect(parsed.edges.map((e) => e.id)).toEqual(["e2"]);
  });

  it("tolerates a non-array nodes/edges field", () => {
    expect(parseCanvas(JSON.stringify({ nodes: "oops", edges: 3 }))).toEqual(emptyCanvas());
  });
});

describe("serializeCanvas", () => {
  it("emits pretty-printed JSON with a trailing newline", () => {
    const text = serializeCanvas(emptyCanvas());
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("\n  ");
    expect(JSON.parse(text)).toEqual({ nodes: [], edges: [] });
  });
});

describe("node/edge factories", () => {
  it("makeTextNode / makeFileNode produce valid, uniquely-ided nodes", () => {
    const t = makeTextNode(5, 6, "body");
    expect(t).toMatchObject({ type: "text", x: 5, y: 6, text: "body" });
    expect(t.width).toBeGreaterThan(0);
    const f = makeFileNode(1, 2, "a/b.md");
    expect(f).toMatchObject({ type: "file", x: 1, y: 2, file: "a/b.md" });
    expect(t.id).not.toBe(f.id);
    expect(t.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("makeEdge only sets sides when provided", () => {
    expect(makeEdge("a", "b")).toMatchObject({ fromNode: "a", toNode: "b" });
    expect(makeEdge("a", "b")).not.toHaveProperty("fromSide");
    const e = makeEdge("a", "b", "right", "left");
    expect(e.fromSide).toBe("right");
    expect(e.toSide).toBe("left");
  });

  it("genId returns distinct 16-hex ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => genId()));
    expect(ids.size).toBe(200);
  });
});

describe("geometry", () => {
  const node = { id: "n", type: "text", x: 100, y: 200, width: 300, height: 100 };

  it("anchorPoint returns the midpoint of each side", () => {
    expect(anchorPoint(node, "top")).toEqual({ x: 250, y: 200 });
    expect(anchorPoint(node, "bottom")).toEqual({ x: 250, y: 300 });
    expect(anchorPoint(node, "left")).toEqual({ x: 100, y: 250 });
    expect(anchorPoint(node, "right")).toEqual({ x: 400, y: 250 });
  });

  it("autoSides picks facing sides on the dominant axis", () => {
    const a = { id: "a", type: "text", x: 0, y: 0, width: 100, height: 100 };
    const right = { id: "b", type: "text", x: 400, y: 0, width: 100, height: 100 };
    const below = { id: "c", type: "text", x: 0, y: 400, width: 100, height: 100 };
    expect(autoSides(a, right)).toEqual({ fromSide: "right", toSide: "left" });
    expect(autoSides(right, a)).toEqual({ fromSide: "left", toSide: "right" });
    expect(autoSides(a, below)).toEqual({ fromSide: "bottom", toSide: "top" });
    expect(autoSides(below, a)).toEqual({ fromSide: "top", toSide: "bottom" });
  });
});

describe("resolveColor", () => {
  it("maps preset slots to hex and passes custom hex through", () => {
    expect(resolveColor("1")).toBe("#e5534b");
    expect(resolveColor("#123456")).toBe("#123456");
    expect(resolveColor(undefined)).toBeUndefined();
    expect(resolveColor("")).toBeUndefined();
  });
});
