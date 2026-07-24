import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { ArrowUpRight, Loader2, Share2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, events, type FullGraph } from "../ipc/api";
import { colorForNotePath } from "../lib/colors";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";

/** Above this the per-node labels disappear (hover titles remain) — full
 *  labels at thousands of nodes are unreadable and triple the DOM. The Canvas
 *  renderer for very large vaults is a planned follow-up (Graph Phase 4). */
const SVG_NODE_LIMIT = 500;

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

interface SimNode extends SimulationNodeDatum {
  id: string;
  title: string;
  color: string | null;
  degree: number;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  /** Shared key between the rendered <line> and the sim link. */
  key: string;
}

const edgeKey = (source: string, target: string) => `${source}→${target}`;

const nodeRadius = (n: SimNode) => 4 + Math.min(8, n.degree);

/** Whole-vault force-directed link graph. Layout runs in a rAF-stepped
 *  d3-force simulation with positions written imperatively to the SVG (React
 *  renders the structure once per graph; per-tick attribute writes never go
 *  through state). Pan via drag, zoom via wheel; click opens the note.
 *
 *  With `focusPath` it becomes the LOCAL graph (LinksPanel overlay): a
 *  client-side BFS slices the depth-N neighborhood out of the same full
 *  fetch, the focus note is pinned at the center, and a 1/2/3 depth stepper
 *  expands the horizon. */
export default function GraphView({
  focusPath,
  initialDepth = 1,
  onNavigate,
}: {
  focusPath?: string;
  initialDepth?: number;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation(["common", "links"]);
  const folderColors = useVault((s) => s.folderColors);
  const [graph, setGraph] = useState<FullGraph | null>(null);
  const [depth, setDepth] = useState(initialDepth);

  // Fetch on mount; refetch (debounced) when the index changes underneath —
  // the watcher events fire for both our own writes and external ones.
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const load = () => {
      void api
        .fullGraph()
        .then((g) => {
          if (!cancelled) setGraph(g);
        })
        .catch(() => {});
    };
    load();
    const queue = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(load, 800);
    };
    const unlisten = [
      events.noteChanged.listen(queue),
      events.noteDeleted.listen(queue),
      events.reindexedEvent.listen(queue),
    ];
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      for (const p of unlisten) void p.then((off) => off());
    };
  }, []);

  // Sim state lives in refs: the simulation mutates node positions in place
  // and `draw` writes them straight to the DOM.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const sceneRef = useRef<SVGGElement | null>(null);
  const nodeEls = useRef(new Map<string, SVGGElement>());
  const edgeEls = useRef(new Map<string, SVGLineElement>());
  const simNodes = useRef<SimNode[]>([]);
  const simLinks = useRef<SimLink[]>([]);
  // Pan/zoom (device-local, ephemeral): translate is relative to the centered
  // origin; scale clamps to [MIN_ZOOM, MAX_ZOOM].
  const view = useRef({ x: 0, y: 0, k: 1 });

  const draw = useCallback(() => {
    const svg = svgRef.current;
    const scene = sceneRef.current;
    if (!svg || !scene) return;
    const cx = svg.clientWidth / 2;
    const cy = svg.clientHeight / 2;
    const { x, y, k } = view.current;
    scene.setAttribute("transform", `translate(${cx + x},${cy + y}) scale(${k})`);
    for (const n of simNodes.current) {
      nodeEls.current.get(n.id)?.setAttribute("transform", `translate(${n.x ?? 0},${n.y ?? 0})`);
    }
    for (const l of simLinks.current) {
      const el = edgeEls.current.get(l.key);
      const s = l.source as SimNode;
      const tgt = l.target as SimNode;
      if (!el) continue;
      el.setAttribute("x1", String(s.x ?? 0));
      el.setAttribute("y1", String(s.y ?? 0));
      el.setAttribute("x2", String(tgt.x ?? 0));
      el.setAttribute("y2", String(tgt.y ?? 0));
    }
  }, []);

  // Focus mode: slice the depth-N neighborhood (undirected BFS) out of the
  // full graph. Whole-vault mode passes the fetch through untouched.
  const visible = useMemo<FullGraph | null>(() => {
    if (!graph || !focusPath) return graph;
    const adj = new Map<string, string[]>();
    const link = (a: string, b: string) => {
      const list = adj.get(a);
      if (list) list.push(b);
      else adj.set(a, [b]);
    };
    for (const e of graph.edges) {
      link(e.source, e.target);
      link(e.target, e.source);
    }
    const dist = new Map([[focusPath, 0]]);
    const queue = [focusPath];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const d = dist.get(cur)!;
      if (d >= depth) continue;
      for (const next of adj.get(cur) ?? []) {
        if (!dist.has(next)) {
          dist.set(next, d + 1);
          queue.push(next);
        }
      }
    }
    return {
      nodes: graph.nodes.filter((n) => dist.has(n.path)),
      edges: graph.edges.filter((e) => dist.has(e.source) && dist.has(e.target)),
    };
  }, [graph, focusPath, depth]);

  // (Re)build + run the simulation when the graph data changes. Colors are
  // applied during React render (folderColors changes recolor without
  // disturbing positions or restarting the layout). A REFETCH carries node
  // positions over by id, so an index update adjusts the settled layout
  // instead of replaying it from scratch.
  const nodes = useMemo(() => {
    if (!visible) return [];
    const degree = new Map<string, number>();
    for (const e of visible.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const prev = new Map(simNodes.current.map((n) => [n.id, n]));
    return visible.nodes.map((n, i) => {
      const carried = prev.get(n.path);
      const focus = n.path === focusPath;
      return {
        id: n.path,
        title: n.title,
        color: null as string | null, // filled at render from folderColors
        degree: degree.get(n.path) ?? 0,
        // Carried positions for known nodes; a deterministic spiral spread for
        // new ones (stable first frames, reproducible layout per vault). The
        // focus note is pinned at the center (fx/fy).
        x: focus ? 0 : (carried?.x ?? Math.cos(i * 0.5) * (10 + i * 2)),
        y: focus ? 0 : (carried?.y ?? Math.sin(i * 0.5) * (10 + i * 2)),
        ...(focus ? { fx: 0, fy: 0 } : {}),
      };
    });
  }, [visible, focusPath]);

  // One edge list shared by the sim AND the rendered <line> elements, so the
  // DOM map and the link array can never drift apart (keys, not indices).
  const links = useMemo<SimLink[]>(() => {
    if (!visible) return [];
    const ids = new Set(visible.nodes.map((n) => n.path));
    return visible.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, key: edgeKey(e.source, e.target) }));
  }, [visible]);

  useEffect(() => {
    if (nodes.length === 0) return;
    const carriedOver = simNodes.current.length > 0;
    simNodes.current = nodes;
    simLinks.current = links;

    const sim = forceSimulation(nodes)
      .force("charge", forceManyBody().strength(-120))
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(70),
      )
      .force("center", forceCenter(0, 0).strength(0.05))
      .force("collide", forceCollide<SimNode>((d) => nodeRadius(d) + 4))
      .alphaDecay(0.04);
    // A refetch restart only ADJUSTS the carried-over layout (low alpha)
    // instead of replaying the full settle animation.
    if (carriedOver) sim.alpha(0.25);
    sim.stop(); // stepped manually so layout work pauses with the rAF loop

    let raf = 0;
    const tick = () => {
      sim.tick();
      draw();
      if (sim.alpha() > sim.alphaMin()) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      sim.stop();
    };
  }, [nodes, links, draw]);

  // Keep the centered origin honest across container resizes (the sim loop
  // stops once settled, so resizes need their own redraw).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(svg);
    return () => ro.disconnect();
  }, [draw]);

  // Drag-pan on the background; wheel-zoom around the cursor.
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.target instanceof Element && e.target.closest("[data-node]")) return;
    const start = { px: e.clientX, py: e.clientY, x: view.current.x, y: view.current.y };
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      view.current.x = start.x + (ev.clientX - start.px);
      view.current.y = start.y + (ev.clientY - start.py);
      draw();
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    // pointercancel (touch interruption / capture loss) must tear down too,
    // or the stale move handler fights the next drag.
    el.addEventListener("pointercancel", onUp);
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const { x, y, k } = view.current;
    const k2 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k * Math.exp(-e.deltaY * 0.002)));
    // Keep the world point under the cursor fixed while scaling.
    const px = e.clientX - rect.left - rect.width / 2;
    const py = e.clientY - rect.top - rect.height / 2;
    view.current = {
      x: px - ((px - x) / k) * k2,
      y: py - ((py - y) / k) * k2,
      k: k2,
    };
    draw();
  };

  const openNode = (path: string) => {
    // Open as a tab in the focused pane and jump to the Notes view
    // (openInWorkspace flushes the outgoing note first). The local-graph
    // overlay closes itself via onNavigate.
    useUi.getState().openInWorkspace(path);
    onNavigate?.();
  };

  if (!visible) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-fg-faint">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-sm">{t("common:loading")}</span>
      </div>
    );
  }

  if (visible.nodes.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-fg-faint">
        <Share2 size={40} strokeWidth={1.25} />
        <p className="text-sm text-fg-muted">
          {focusPath ? t("links:noGraph") : t("common:graph.empty")}
        </p>
        <button
          type="button"
          onClick={() => useUi.getState().openHelp("graphView")}
          className="flex items-center gap-1 text-xs text-fg-subtle transition-colors hover:text-fg"
        >
          {t("common:helpGuide")}
          <ArrowUpRight size={12} />
        </button>
      </div>
    );
  }

  const showLabels = visible.nodes.length <= SVG_NODE_LIMIT;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <svg
        ref={svgRef}
        className="h-full w-full flex-1 cursor-grab touch-none select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onWheel={onWheel}
        role="img"
        aria-label={t("common:views.graph")}
      >
        <g ref={sceneRef}>
          <g stroke="var(--border-strong)" strokeOpacity={0.6}>
            {links.map((l) => (
              <line
                key={l.key}
                ref={(el) => {
                  if (el) edgeEls.current.set(l.key, el);
                  else edgeEls.current.delete(l.key);
                }}
              />
            ))}
          </g>
          {nodes.map((n) => (
            <g
              key={n.id}
              data-node=""
              ref={(el) => {
                if (el) nodeEls.current.set(n.id, el);
                else nodeEls.current.delete(n.id);
              }}
              onClick={() => openNode(n.id)}
              className="cursor-pointer"
            >
              <title>{n.title}</title>
              <circle
                r={nodeRadius(n)}
                fill={colorForNotePath(n.id, folderColors) ?? "var(--fg-faint)"}
                stroke={n.id === focusPath ? "var(--accent)" : undefined}
                strokeWidth={n.id === focusPath ? 2 : undefined}
                className="transition-opacity hover:opacity-75"
              />
              {showLabels && (
                <text
                  y={nodeRadius(n) + 11}
                  textAnchor="middle"
                  fill="var(--fg-muted)"
                  fontSize={10}
                  className="pointer-events-none"
                >
                  {n.title}
                </text>
              )}
            </g>
          ))}
        </g>
      </svg>
      {focusPath && (
        <div className="absolute right-3 top-3 flex items-center gap-1 rounded-md bg-surface/80 px-2 py-1 text-xs text-fg-muted backdrop-blur">
          <span className="text-fg-faint">{t("links:depth")}</span>
          {([1, 2, 3] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDepth(d)}
              aria-pressed={depth === d}
              className={`rounded px-1.5 py-0.5 tabular-nums transition-colors ${
                depth === d ? "bg-active text-fg" : "hover:bg-hover"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 right-3 rounded-md bg-surface/80 px-2 py-1 text-xs tabular-nums text-fg-faint backdrop-blur">
        {t("common:graph.notesCount", { n: visible.nodes.length })} ·{" "}
        {t("common:graph.linksCount", { n: visible.edges.length })}
      </div>
    </div>
  );
}
