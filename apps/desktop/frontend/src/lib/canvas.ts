// The JSON Canvas document model (the portable, Obsidian-compatible `.canvas`
// format) plus the pure (de)serialization and geometry helpers the canvas view
// builds on. Kept dependency-free and side-effect-free so it is unit-testable
// and so the whole canvas feature stays out of the main bundle behind a lazy
// import. The backend treats a `.canvas` as opaque JSON — this module is the
// single place that understands its shape.

/** A node/edge color: a `#rrggbb` hex string or a preset number `"1"`–`"6"`. */
export type CanvasColor = string;

/** The side of a node an edge attaches to. */
export type CanvasSide = "top" | "right" | "bottom" | "left";

/** A canvas node. `file`/`text`/`url`/`label` are the type-specific fields from
 *  the JSON Canvas spec; the index signature carries any other spec (or future)
 *  fields untouched so a round-trip is byte-faithful. */
export interface CanvasNode {
  id: string;
  /** `"file" | "text" | "group" | "link"` (we render file/text richly; others
   *  are preserved and shown as a labelled placeholder). */
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  /** file node: vault-relative path to the embedded note/attachment. */
  file?: string;
  /** file node: optional heading/block subpath. */
  subpath?: string;
  /** text node: Markdown body. */
  text?: string;
  /** link node: external URL. */
  url?: string;
  /** group node: label. */
  label?: string;
  [extra: string]: unknown;
}

/** A directed edge between two nodes. */
export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: CanvasSide;
  toSide?: CanvasSide;
  color?: CanvasColor;
  label?: string;
  [extra: string]: unknown;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface Point {
  x: number;
  y: number;
}

export const DEFAULT_FILE_WIDTH = 300;
export const DEFAULT_FILE_HEIGHT = 220;
export const DEFAULT_TEXT_WIDTH = 260;
export const DEFAULT_TEXT_HEIGHT = 120;

/** Preset color slots (`"1"`–`"6"`) → hex, matching the JSON Canvas convention
 *  (red/orange/yellow/green/cyan/purple). Custom colors are already hex. */
export const CANVAS_PRESET_COLORS: Record<string, string> = {
  "1": "#e5534b",
  "2": "#d9730d",
  "3": "#dfab01",
  "4": "#4d9a5f",
  "5": "#3d8bd4",
  "6": "#8b5cd6",
};

/** Resolve a node/edge color to a CSS hex, or undefined for "no color". */
export function resolveColor(color?: CanvasColor): string | undefined {
  if (!color) return undefined;
  return CANVAS_PRESET_COLORS[color] ?? color;
}

export function emptyCanvas(): CanvasData {
  return { nodes: [], edges: [] };
}

/** A 16-hex-char id, matching Obsidian's canvas node/edge id style. */
export function genId(): string {
  let s = "";
  for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

function toNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Coerce an arbitrary object into a renderable node, preserving unknown fields
 *  and filling in missing geometry with defaults. Returns null for entries
 *  without the required `id`/`type` (which can't be positioned or rendered). */
function normalizeNode(raw: unknown): CanvasNode | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.id !== "string" || typeof n.type !== "string") return null;
  return {
    ...n,
    id: n.id,
    type: n.type,
    x: toNum(n.x, 0),
    y: toNum(n.y, 0),
    width: toNum(n.width, DEFAULT_TEXT_WIDTH),
    height: toNum(n.height, DEFAULT_TEXT_HEIGHT),
  } as CanvasNode;
}

function normalizeEdge(raw: unknown): CanvasEdge | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (
    typeof e.id !== "string" ||
    typeof e.fromNode !== "string" ||
    typeof e.toNode !== "string"
  ) {
    return null;
  }
  return { ...e, id: e.id, fromNode: e.fromNode, toNode: e.toNode } as CanvasEdge;
}

/** Parse a `.canvas` file's JSON text into a canvas model. Tolerant of empty /
 *  malformed input (returns an empty canvas) so a brand-new or partially-written
 *  file never throws in the view. */
export function parseCanvas(json: string): CanvasData {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return emptyCanvas();
  }
  if (!raw || typeof raw !== "object") return emptyCanvas();
  const obj = raw as { nodes?: unknown; edges?: unknown };
  const nodes = Array.isArray(obj.nodes)
    ? obj.nodes.map(normalizeNode).filter((n): n is CanvasNode => n !== null)
    : [];
  const edges = Array.isArray(obj.edges)
    ? obj.edges.map(normalizeEdge).filter((e): e is CanvasEdge => e !== null)
    : [];
  return { nodes, edges };
}

/** Serialize a canvas model back to pretty-printed JSON Canvas text (2-space
 *  indent + trailing newline, for clean git diffs). */
export function serializeCanvas(data: CanvasData): string {
  return `${JSON.stringify({ nodes: data.nodes, edges: data.edges }, null, 2)}\n`;
}

export function makeTextNode(x: number, y: number, text = ""): CanvasNode {
  return {
    id: genId(),
    type: "text",
    x,
    y,
    width: DEFAULT_TEXT_WIDTH,
    height: DEFAULT_TEXT_HEIGHT,
    text,
  };
}

export function makeFileNode(x: number, y: number, file: string): CanvasNode {
  return {
    id: genId(),
    type: "file",
    x,
    y,
    width: DEFAULT_FILE_WIDTH,
    height: DEFAULT_FILE_HEIGHT,
    file,
  };
}

export function makeEdge(
  fromNode: string,
  toNode: string,
  fromSide?: CanvasSide,
  toSide?: CanvasSide,
): CanvasEdge {
  const edge: CanvasEdge = { id: genId(), fromNode, toNode };
  if (fromSide) edge.fromSide = fromSide;
  if (toSide) edge.toSide = toSide;
  return edge;
}

/** The world-space point where an edge meets `side` of `node`. */
export function anchorPoint(node: CanvasNode, side: CanvasSide): Point {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

/** Pick the pair of facing sides for an edge between two nodes from their
 *  relative centers (the dominant axis wins), so an auto-drawn edge leaves and
 *  enters on sensible sides. */
export function autoSides(
  from: CanvasNode,
  to: CanvasNode,
): { fromSide: CanvasSide; toSide: CanvasSide } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { fromSide: "right", toSide: "left" }
      : { fromSide: "left", toSide: "right" };
  }
  return dy >= 0
    ? { fromSide: "bottom", toSide: "top" }
    : { fromSide: "top", toSide: "bottom" };
}
