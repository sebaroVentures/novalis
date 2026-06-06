import { useEffect, useMemo, useState } from "react";

import { Network, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, type NoteGraph } from "../ipc/api";
import { useUi } from "../stores/uiStore";

interface GraphModalProps {
  open: boolean;
  /** The note whose 1-hop neighborhood we render. */
  path: string;
  onClose: () => void;
}

const W = 720;
const H = 480;

interface Placed {
  path: string;
  title: string;
  x: number;
  y: number;
  center: boolean;
}

/** Place the center note in the middle and its neighbors evenly on a ring. */
function layout(graph: NoteGraph): Placed[] {
  const cx = W / 2;
  const cy = H / 2;
  const neighbors = graph.nodes.filter((n) => n.path !== graph.center);
  const radius = Math.min(W, H) / 2 - 90;
  const placed: Placed[] = [];
  const center = graph.nodes.find((n) => n.path === graph.center);
  if (center) placed.push({ ...center, x: cx, y: cy, center: true });
  neighbors.forEach((n, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / neighbors.length;
    placed.push({
      ...n,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      center: false,
    });
  });
  return placed;
}

function truncate(title: string): string {
  return title.length > 18 ? `${title.slice(0, 17)}…` : title;
}

/** Local link-graph view: the open note plus the notes it links to and the
 *  notes that link to it. Rendered as a self-contained SVG (no graph lib);
 *  clicking a neighbor opens it. Outgoing edges use the accent color, incoming
 *  edges a muted color. */
export function GraphModal({ open, path, onClose }: GraphModalProps) {
  const { t } = useTranslation("links");
  const openInWorkspace = useUi((s) => s.openInWorkspace);
  const [graph, setGraph] = useState<NoteGraph | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setGraph(null);
    api
      .noteGraph(path)
      .then((g) => {
        if (active) setGraph(g);
      })
      .catch(() => {
        if (active) setGraph({ center: path, nodes: [], edges: [] });
      });
    return () => {
      active = false;
    };
  }, [open, path]);

  const placed = useMemo(() => (graph ? layout(graph) : []), [graph]);
  const posByPath = useMemo(() => new Map(placed.map((p) => [p.path, p])), [placed]);

  if (!open) return null;

  const hasNeighbors = placed.length > 1;
  const go = (p: string) => {
    openInWorkspace(p);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <span className="flex items-center gap-2 text-sm font-medium text-fg">
            <Network size={15} />
            {t("graph")}
          </span>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-fg-muted transition-colors hover:bg-active hover:text-fg"
          >
            <X size={16} />
          </button>
        </header>

        <div className="relative min-h-0 flex-1">
          {graph && !hasNeighbors ? (
            <div className="flex h-full items-center justify-center text-sm text-fg-faint">
              {t("noGraph")}
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${W} ${H}`}
              preserveAspectRatio="xMidYMid meet"
              className="h-full w-full"
            >
              {/* Edges first, so nodes draw on top. */}
              {graph?.edges.map((e, i) => {
                const a = posByPath.get(e.source);
                const b = posByPath.get(e.target);
                if (!a || !b) return null;
                const outgoing = e.source === graph.center;
                return (
                  <line
                    key={`${e.source}->${e.target}:${i}`}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    className={`stroke-current opacity-50 ${
                      outgoing ? "text-accent" : "text-fg-faint"
                    }`}
                    strokeWidth={1.5}
                  />
                );
              })}
              {placed.map((n) => (
                <g
                  key={n.path}
                  transform={`translate(${n.x},${n.y})`}
                  className={n.center ? "" : "cursor-pointer"}
                  onClick={n.center ? undefined : () => go(n.path)}
                >
                  <circle
                    r={n.center ? 11 : 7}
                    className={`fill-current ${n.center ? "text-accent" : "text-fg-muted"}`}
                  />
                  <text
                    y={n.center ? 28 : 22}
                    textAnchor="middle"
                    className={`fill-current text-[12px] ${
                      n.center ? "font-semibold text-fg" : "text-fg-muted"
                    }`}
                  >
                    {truncate(n.title)}
                  </text>
                </g>
              ))}
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}
