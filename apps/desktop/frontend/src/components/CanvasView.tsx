import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  ArrowLeft,
  FileText,
  Loader2,
  Maximize,
  Plus,
  StickyNote,
  Trash2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  anchorPoint,
  autoSides,
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
  type CanvasSide,
  emptyCanvas,
  makeEdge,
  makeFileNode,
  makeTextNode,
  parseCanvas,
  type Point,
  resolveColor,
  serializeCanvas,
} from "../lib/canvas";
import { api, type CanvasFile } from "../ipc/api";
import { useCanvas } from "../stores/canvasStore";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";
import { NotePickerModal } from "./NotePickerModal";
import { ConfirmDialog } from "./ui/ConfirmDialog";

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const MIN_NODE_W = 120;
const MIN_NODE_H = 60;

/** Screen↔world camera: `screen = world * zoom + (tx, ty)`. */
interface Camera {
  tx: number;
  ty: number;
  zoom: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// ── Gallery ──────────────────────────────────────────────────────────────────

/** Grid of the vault's `.canvas` files with create/open/delete. Shown when no
 *  canvas is open. */
function CanvasGallery() {
  const { t } = useTranslation("common");
  const vaultPath = useVault((s) => s.vaultPath);
  const openCanvas = useCanvas((s) => s.openCanvas);
  const createAndOpen = useCanvas((s) => s.createAndOpen);
  const [files, setFiles] = useState<CanvasFile[] | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CanvasFile | null>(null);

  const refresh = useCallback(() => {
    void api
      .listCanvases()
      .then(setFiles)
      .catch(() => setFiles([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, vaultPath]);

  const doDelete = (file: CanvasFile) => {
    void (async () => {
      try {
        await api.deleteCanvas(file.path);
      } catch (e) {
        useVault.getState().reportError(e);
      } finally {
        setPendingDelete(null);
        refresh();
      }
    })();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-app">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h1 className="text-sm font-semibold text-fg">{t("canvas.gallery.title")}</h1>
        <button
          onClick={() => void createAndOpen()}
          className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent/90"
        >
          <Plus size={14} />
          {t("canvas.new")}
        </button>
      </div>

      {files === null ? (
        <div className="flex flex-1 items-center justify-center text-sm text-fg-faint">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : files.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <StickyNote size={28} className="text-fg-faint" />
          <div>
            <p className="text-sm font-medium text-fg-muted">{t("canvas.gallery.empty")}</p>
            <p className="mt-1 text-xs text-fg-faint">{t("canvas.gallery.emptyHint")}</p>
          </div>
          <button
            onClick={() => void createAndOpen()}
            className="mt-1 flex items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-hover"
          >
            <Plus size={14} />
            {t("canvas.new")}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3 p-4">
          {files.map((f) => (
            <div
              key={f.path}
              role="button"
              tabIndex={0}
              onClick={() => openCanvas(f.path)}
              onKeyDown={(e) => {
                // Ignore keys bubbling up from the nested delete button.
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openCanvas(f.path);
                }
              }}
              className="group relative flex h-32 cursor-pointer flex-col justify-end rounded-lg border border-border bg-surface p-3 outline-none transition-colors hover:border-border-strong hover:bg-hover focus-visible:border-border-strong focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/50"
            >
              <StickyNote size={18} className="absolute left-3 top-3 text-fg-subtle" />
              <button
                title={t("canvas.deleteCanvas")}
                onClick={(e) => {
                  e.stopPropagation();
                  setPendingDelete(f);
                }}
                className="absolute right-2 top-2 rounded p-1 text-fg-subtle opacity-0 transition-opacity hover:bg-active hover:text-danger group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              >
                <Trash2 size={14} />
              </button>
              <p className="truncate text-sm font-medium text-fg">{f.name}</p>
              <p className="truncate text-[11px] text-fg-faint">{f.path}</p>
            </div>
          ))}
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          open
          danger
          title={t("canvas.deleteCanvas")}
          body={t("canvas.deleteCanvasConfirm", { name: pendingDelete.name })}
          confirmLabel={t("delete")}
          onConfirm={() => doDelete(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

// ── File-card note preview (reuses the getNote preview pattern) ───────────────

/** Strip leading YAML frontmatter and return the first lines as a short excerpt
 *  (same approach as WikiLinkHoverCard). */
function excerptOf(content: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  if (!body) return "";
  const text = body
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(" ");
  return text.length > 320 ? `${text.slice(0, 320)}…` : text;
}

type PreviewState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; title: string; excerpt: string };

function FileCardBody({ file }: { file: string }) {
  const { t } = useTranslation("common");
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const note = await api.getNote(file);
        if (active) setState({ kind: "ready", title: note.title, excerpt: excerptOf(note.content) });
      } catch {
        if (active) setState({ kind: "missing" });
      }
    })();
    return () => {
      active = false;
    };
  }, [file]);

  if (state.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-fg-faint">
        <Loader2 size={14} className="animate-spin" />
      </div>
    );
  }
  if (state.kind === "missing") {
    return (
      <div className="flex h-full flex-col gap-1 p-3">
        <span className="truncate text-xs font-medium text-danger">
          {t("canvas.missingFile", { file })}
        </span>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col gap-1 overflow-hidden p-3">
      <div className="flex items-center gap-1.5">
        <FileText size={13} className="shrink-0 text-fg-subtle" />
        <span className="truncate text-sm font-semibold text-fg">
          {state.title || t("canvas.untitled")}
        </span>
      </div>
      <p className="min-h-0 flex-1 overflow-hidden whitespace-pre-wrap text-xs leading-snug text-fg-muted">
        {state.excerpt}
      </p>
    </div>
  );
}

// ── Node card ─────────────────────────────────────────────────────────────────

const SIDES: CanvasSide[] = ["top", "right", "bottom", "left"];

interface NodeCardProps {
  node: CanvasNode;
  selected: boolean;
  onPointerDownBody: (e: React.PointerEvent, node: CanvasNode) => void;
  onStartResize: (e: React.PointerEvent, node: CanvasNode) => void;
  onStartConnect: (e: React.PointerEvent, node: CanvasNode, side: CanvasSide) => void;
  onCommitText: (id: string, text: string) => void;
  onOpenFile: (file: string) => void;
}

const NodeCard = memo(function NodeCard({
  node,
  selected,
  onPointerDownBody,
  onStartResize,
  onStartConnect,
  onCommitText,
  onOpenFile,
}: NodeCardProps) {
  const { t } = useTranslation("common");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.text ?? "");
  const accent = resolveColor(node.color);

  const commitText = () => {
    setEditing(false);
    if (draft !== (node.text ?? "")) onCommitText(node.id, draft);
  };

  return (
    <div
      data-node-id={node.id}
      onPointerDown={(e) => {
        if (editing) return;
        onPointerDownBody(e, node);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (node.type === "text") {
          setDraft(node.text ?? "");
          setEditing(true);
        } else if (node.type === "file" && node.file) {
          onOpenFile(node.file);
        }
      }}
      style={{
        position: "absolute",
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        borderTopColor: accent,
        borderTopWidth: accent ? 3 : undefined,
      }}
      className={`group/node overflow-hidden rounded-lg border bg-surface shadow-sm transition-shadow ${
        selected ? "border-accent ring-2 ring-accent/40" : "border-border-strong hover:shadow-md"
      }`}
    >
      {node.type === "text" ? (
        editing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                setEditing(false);
                setDraft(node.text ?? "");
              }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            placeholder={t("canvas.textPlaceholder")}
            className="h-full w-full resize-none bg-transparent p-3 text-sm text-fg outline-none placeholder:text-fg-faint"
          />
        ) : (
          <div className="h-full w-full overflow-hidden whitespace-pre-wrap p-3 text-sm text-fg">
            {node.text || <span className="text-fg-faint">{t("canvas.emptyCard")}</span>}
          </div>
        )
      ) : node.type === "file" && node.file ? (
        <FileCardBody file={node.file} />
      ) : (
        <div className="flex h-full flex-col gap-1 p-3">
          <span className="truncate text-xs font-medium text-fg-muted">
            {node.label || node.url || node.type}
          </span>
        </div>
      )}

      {/* Resize handle (bottom-right). */}
      <div
        onPointerDown={(e) => {
          e.stopPropagation();
          onStartResize(e, node);
        }}
        className="absolute bottom-0 right-0 h-3.5 w-3.5 cursor-nwse-resize opacity-0 group-hover/node:opacity-100"
        style={{
          background:
            "linear-gradient(135deg, transparent 50%, var(--color-border-strong, #888) 50%)",
        }}
      />

      {/* Connection handles (one per side), shown on hover. */}
      {SIDES.map((side) => {
        // eslint-disable-next-line i18next/no-literal-string -- CSS keyword, not display text
        const pos: React.CSSProperties = { position: "absolute" };
        if (side === "top") Object.assign(pos, { top: -5, left: "50%", marginLeft: -5 });
        if (side === "bottom") Object.assign(pos, { bottom: -5, left: "50%", marginLeft: -5 });
        if (side === "left") Object.assign(pos, { left: -5, top: "50%", marginTop: -5 });
        if (side === "right") Object.assign(pos, { right: -5, top: "50%", marginTop: -5 });
        return (
          <div
            key={side}
            onPointerDown={(e) => {
              e.stopPropagation();
              onStartConnect(e, node, side);
            }}
            style={pos}
            className="h-2.5 w-2.5 cursor-crosshair rounded-full border border-accent bg-surface opacity-0 transition-opacity group-hover/node:opacity-100 hover:scale-125 hover:bg-accent"
          />
        );
      })}
    </div>
  );
});

// ── Edge geometry ─────────────────────────────────────────────────────────────

function sideOf(edge: CanvasEdge, from: CanvasNode, to: CanvasNode): [CanvasSide, CanvasSide] {
  if (edge.fromSide && edge.toSide) return [edge.fromSide, edge.toSide];
  const auto = autoSides(from, to);
  return [edge.fromSide ?? auto.fromSide, edge.toSide ?? auto.toSide];
}

function normalOf(side: CanvasSide): Point {
  switch (side) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
  }
}

/** Cubic-bezier path between two anchors, bowing out along each side normal. */
function edgePath(a: Point, sideA: CanvasSide, b: Point, sideB: CanvasSide): string {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const off = clamp(dist * 0.4, 40, 240);
  const na = normalOf(sideA);
  const nb = normalOf(sideB);
  const c1 = { x: a.x + na.x * off, y: a.y + na.y * off };
  const c2 = { x: b.x + nb.x * off, y: b.y + nb.y * off };
  return `M ${a.x} ${a.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`;
}

// ── Canvas editor ─────────────────────────────────────────────────────────────

type SaveState = "idle" | "saving" | "saved" | "error";

/** Live drag/resize/pan/connect gesture (kept in a ref, not state, so pointer
 *  moves don't re-render until the model actually changes). */
type Gesture =
  | { kind: "pan"; startX: number; startY: number; camTx: number; camTy: number }
  | { kind: "move"; id: string; startX: number; startY: number; nodeX: number; nodeY: number }
  | { kind: "resize"; id: string; startX: number; startY: number; w: number; h: number }
  | { kind: "connect"; from: string; fromSide: CanvasSide };

function CanvasEditor({ path }: { path: string }) {
  const { t } = useTranslation("common");
  const closeCanvas = useCanvas((s) => s.closeCanvas);
  const setFlushHandler = useCanvas((s) => s.setFlushHandler);
  const openInWorkspace = useUi((s) => s.openInWorkspace);

  const [data, setData] = useState<CanvasData>(emptyCanvas());
  const [cam, setCam] = useState<Camera>({ tx: 80, ty: 80, zoom: 1 });
  const [loadError, setLoadError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingEdge, setPendingEdge] = useState<Point | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const camRef = useRef(cam);
  camRef.current = cam;
  const gestureRef = useRef<Gesture | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  // The write currently hitting disk (if any), so a drain can await it even
  // when there's no fresh edit left to schedule.
  const inFlight = useRef<Promise<void> | null>(null);
  const latestData = useRef<CanvasData>(data);
  // True only while there is an unsaved edit — gates the unmount flush so a
  // canvas that was opened but never changed (or closed before it finished
  // loading) can't be overwritten with stale/empty content.
  const unsaved = useRef(false);

  // ── Persistence ────────────────────────────────────────────────────────────
  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    // No fresh edit to persist — but still wait for any write already on its way
    // to disk so a quit drain can be sure the file has settled.
    if (!unsaved.current) {
      await inFlight.current;
      return;
    }
    unsaved.current = false;
    const write = (async () => {
      try {
        await api.writeCanvas(path, serializeCanvas(latestData.current));
        setSaveState("saved");
      } catch (e) {
        unsaved.current = true;
        setSaveState("error");
        useVault.getState().reportError(e);
      }
    })();
    inFlight.current = write;
    await write;
  }, [path]);

  const scheduleSave = useCallback(
    (next: CanvasData) => {
      latestData.current = next;
      unsaved.current = true;
      setSaveState("saving");
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => void flush(), 600);
    },
    [flush],
  );

  /** Apply a model mutation and schedule a save. */
  const commit = useCallback(
    (updater: (d: CanvasData) => CanvasData) => {
      setData((prev) => {
        const next = updater(prev);
        scheduleSave(next);
        return next;
      });
    },
    [scheduleSave],
  );

  // Load on mount / when the path changes.
  useEffect(() => {
    let active = true;
    setLoaded(false);
    setLoadError(false);
    void (async () => {
      try {
        const raw = await api.readCanvas(path);
        if (!active) return;
        const parsed = parseCanvas(raw);
        latestData.current = parsed;
        setData(parsed);
        setLoaded(true);
      } catch {
        if (active) setLoadError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [path]);

  // Flush a pending save when leaving the canvas (unmount / switch). Only when
  // there is an actual unsaved edit — never overwrite the file with content
  // from a canvas that was opened but not modified.
  useEffect(() => {
    return () => {
      window.clearTimeout(saveTimer.current);
      if (unsaved.current) {
        void api
          .writeCanvas(path, serializeCanvas(latestData.current))
          .catch((e) => useVault.getState().reportError(e));
      }
    };
  }, [path]);

  // Expose this editor's pending-save drain to the store so the app can flush a
  // debounced write before it quits (App.tsx onCloseRequested). Cleared on
  // unmount so the store never holds a stale handler.
  useEffect(() => {
    setFlushHandler(flush);
    return () => setFlushHandler(null);
  }, [flush, setFlushHandler]);

  // ── Camera helpers ───────────────────────────────────────────────────────
  const screenToWorld = useCallback((clientX: number, clientY: number): Point => {
    const rect = containerRef.current?.getBoundingClientRect();
    const c = camRef.current;
    const sx = clientX - (rect?.left ?? 0);
    const sy = clientY - (rect?.top ?? 0);
    return { x: (sx - c.tx) / c.zoom, y: (sy - c.ty) / c.zoom };
  }, []);

  const fitTo = useCallback((nodes: CanvasNode[]) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || nodes.length === 0) {
      setCam({ tx: 80, ty: 80, zoom: 1 });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    }
    const pad = 80;
    const zoom = clamp(
      Math.min((rect.width - pad) / (maxX - minX), (rect.height - pad) / (maxY - minY), 1),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    const tx = (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom;
    const ty = (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom;
    setCam({ tx, ty, zoom });
  }, []);

  // Frame the content once, after the first load paints (so the container has
  // a measured size).
  const didFit = useRef(false);
  useLayoutEffect(() => {
    if (loaded && !didFit.current) {
      didFit.current = true;
      fitTo(latestData.current.nodes);
    }
  }, [loaded, fitTo]);

  // ── Gesture handling (window listeners while a pointer is down) ─────────────
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      const c = camRef.current;
      if (g.kind === "pan") {
        setCam({ ...c, tx: g.camTx + (e.clientX - g.startX), ty: g.camTy + (e.clientY - g.startY) });
      } else if (g.kind === "move") {
        const dx = (e.clientX - g.startX) / c.zoom;
        const dy = (e.clientY - g.startY) / c.zoom;
        commit((d) => ({
          ...d,
          nodes: d.nodes.map((n) =>
            n.id === g.id ? { ...n, x: g.nodeX + dx, y: g.nodeY + dy } : n,
          ),
        }));
      } else if (g.kind === "resize") {
        const dx = (e.clientX - g.startX) / c.zoom;
        const dy = (e.clientY - g.startY) / c.zoom;
        commit((d) => ({
          ...d,
          nodes: d.nodes.map((n) =>
            n.id === g.id
              ? { ...n, width: Math.max(MIN_NODE_W, g.w + dx), height: Math.max(MIN_NODE_H, g.h + dy) }
              : n,
          ),
        }));
      } else if (g.kind === "connect") {
        setPendingEdge(screenToWorld(e.clientX, e.clientY));
      }
    };

    const onUp = (e: PointerEvent) => {
      const g = gestureRef.current;
      gestureRef.current = null;
      if (g?.kind === "connect") {
        setPendingEdge(null);
        const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)
          ?.closest("[data-node-id]")
          ?.getAttribute("data-node-id");
        if (target && target !== g.from) {
          commit((d) =>
            d.edges.some((ed) => ed.fromNode === g.from && ed.toNode === target)
              ? d
              : { ...d, edges: [...d.edges, makeEdge(g.from, target, g.fromSide)] },
          );
        }
      }
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [commit, screenToWorld]);

  // Delete the selected node (and its edges) or edge with Delete/Backspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (!selected) return;
      e.preventDefault();
      commit((d) => ({
        nodes: d.nodes.filter((n) => n.id !== selected),
        edges: d.edges.filter(
          (ed) => ed.id !== selected && ed.fromNode !== selected && ed.toNode !== selected,
        ),
      }));
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, commit]);

  // ── Interaction starters ─────────────────────────────────────────────────
  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.button !== 1) return;
    setSelected(null);
    gestureRef.current = { kind: "pan", startX: e.clientX, startY: e.clientY, camTx: cam.tx, camTy: cam.ty };
    document.body.style.userSelect = "none";
  };

  const onNodePointerDown = (e: React.PointerEvent, node: CanvasNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelected(node.id);
    gestureRef.current = {
      kind: "move",
      id: node.id,
      startX: e.clientX,
      startY: e.clientY,
      nodeX: node.x,
      nodeY: node.y,
    };
    document.body.style.userSelect = "none";
  };

  const onStartResize = (e: React.PointerEvent, node: CanvasNode) => {
    setSelected(node.id);
    gestureRef.current = {
      kind: "resize",
      id: node.id,
      startX: e.clientX,
      startY: e.clientY,
      w: node.width,
      h: node.height,
    };
    document.body.style.userSelect = "none";
  };

  const onStartConnect = (e: React.PointerEvent, node: CanvasNode, side: CanvasSide) => {
    gestureRef.current = { kind: "connect", from: node.id, fromSide: side };
    setPendingEdge(screenToWorld(e.clientX, e.clientY));
    document.body.style.userSelect = "none";
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const zoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    // Keep the world point under the cursor fixed while zooming.
    const wx = (sx - cam.tx) / cam.zoom;
    const wy = (sy - cam.ty) / cam.zoom;
    setCam({ zoom, tx: sx - wx * zoom, ty: sy - wy * zoom });
  };

  const zoomBy = (factor: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const cx = (rect?.width ?? 0) / 2;
    const cy = (rect?.height ?? 0) / 2;
    const zoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const wx = (cx - cam.tx) / cam.zoom;
    const wy = (cy - cam.ty) / cam.zoom;
    setCam({ zoom, tx: cx - wx * zoom, ty: cy - wy * zoom });
  };

  /** Add a node near the center of the current viewport. */
  const centerWorld = (): Point => {
    const rect = containerRef.current?.getBoundingClientRect();
    return screenToWorld((rect?.left ?? 0) + (rect?.width ?? 0) / 2, (rect?.top ?? 0) + (rect?.height ?? 0) / 2);
  };

  const addText = () => {
    const c = centerWorld();
    const node = makeTextNode(c.x - 130, c.y - 60);
    commit((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setSelected(node.id);
  };

  const addFile = (file: string) => {
    const c = centerWorld();
    const node = makeFileNode(c.x - 150, c.y - 110, file);
    commit((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setSelected(node.id);
  };

  const nodeById = (id: string) => data.nodes.find((n) => n.id === id);

  if (loadError) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-app">
        <p className="text-sm text-fg-muted">{t("canvas.loadError")}</p>
        <button
          onClick={closeCanvas}
          className="rounded-md border border-border-strong px-3 py-1.5 text-xs text-fg hover:bg-hover"
        >
          {t("canvas.back")}
        </button>
      </div>
    );
  }

  const pendingFromNode = gestureRef.current?.kind === "connect" ? nodeById(gestureRef.current.from) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-app">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <button
          title={t("canvas.back")}
          onClick={closeCanvas}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <ArrowLeft size={15} />
          {t("canvas.back")}
        </button>
        <div className="mx-1 h-4 w-px bg-border" />
        <button
          title={t("canvas.addText")}
          onClick={addText}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <StickyNote size={15} />
          {t("canvas.addText")}
        </button>
        <button
          title={t("canvas.addNote")}
          onClick={() => setPickerOpen(true)}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <FileText size={15} />
          {t("canvas.addNote")}
        </button>

        <div className="ml-auto flex items-center gap-1">
          <span className="mr-1 text-[11px] tabular-nums text-fg-faint">
            {saveState === "saving"
              ? t("canvas.saving")
              : saveState === "error"
                ? t("canvas.saveError")
                : saveState === "saved"
                  ? t("canvas.saved")
                  : ""}
          </span>
          <button
            title={t("canvas.zoomOut")}
            onClick={() => zoomBy(1 / 1.2)}
            className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <ZoomOut size={15} />
          </button>
          <span className="w-10 text-center text-[11px] tabular-nums text-fg-faint">
            {Math.round(cam.zoom * 100)}%
          </span>
          <button
            title={t("canvas.zoomIn")}
            onClick={() => zoomBy(1.2)}
            className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <ZoomIn size={15} />
          </button>
          <button
            title={t("canvas.zoomReset")}
            onClick={() => fitTo(data.nodes)}
            className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <Maximize size={15} />
          </button>
        </div>
      </div>

      {/* Surface */}
      <div
        ref={containerRef}
        onPointerDown={onBackgroundPointerDown}
        onWheel={onWheel}
        className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-app"
        style={{
          backgroundImage:
            "radial-gradient(circle, var(--color-border, #d4d4d4) 1px, transparent 1px)",
          backgroundSize: `${24 * cam.zoom}px ${24 * cam.zoom}px`,
          backgroundPosition: `${cam.tx}px ${cam.ty}px`,
        }}
      >
        {!loaded ? (
          <div className="flex h-full items-center justify-center text-fg-faint">
            <Loader2 size={16} className="animate-spin" />
          </div>
        ) : (
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              transform: `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.zoom})`,
              transformOrigin: "0 0",
            }}
          >
            {/* Edges (below nodes). */}
            <svg
              style={{ position: "absolute", overflow: "visible", width: 0, height: 0 }}
              aria-hidden
            >
              <defs>
                <marker
                  id="nv-canvas-arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" className="fill-fg-subtle" />
                </marker>
              </defs>
              {data.edges.map((edge) => {
                const from = nodeById(edge.fromNode);
                const to = nodeById(edge.toNode);
                if (!from || !to) return null;
                const [sa, sb] = sideOf(edge, from, to);
                const d = edgePath(anchorPoint(from, sa), sa, anchorPoint(to, sb), sb);
                const stroke = resolveColor(edge.color);
                const isSel = selected === edge.id;
                return (
                  <g key={edge.id}>
                    {/* Fat invisible hit path for easy selection. */}
                    <path
                      d={d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={14}
                      style={{ pointerEvents: "stroke", cursor: "pointer" }}
                      vectorEffect="non-scaling-stroke"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        setSelected(edge.id);
                      }}
                    />
                    <path
                      d={d}
                      fill="none"
                      stroke={stroke ?? "var(--color-fg-subtle, #888)"}
                      strokeWidth={isSel ? 3 : 2}
                      className={isSel ? "" : stroke ? "" : "stroke-fg-subtle"}
                      markerEnd="url(#nv-canvas-arrow)"
                      vectorEffect="non-scaling-stroke"
                      style={{ pointerEvents: "none" }}
                    />
                  </g>
                );
              })}
              {/* In-progress connection. */}
              {pendingEdge && pendingFromNode && (
                <path
                  d={edgePath(
                    anchorPoint(
                      pendingFromNode,
                      gestureRef.current?.kind === "connect" ? gestureRef.current.fromSide : "right",
                    ),
                    gestureRef.current?.kind === "connect" ? gestureRef.current.fromSide : "right",
                    pendingEdge,
                    "left",
                  )}
                  fill="none"
                  stroke="var(--color-accent, #6366f1)"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  vectorEffect="non-scaling-stroke"
                  style={{ pointerEvents: "none" }}
                />
              )}
            </svg>

            {/* Nodes. */}
            {data.nodes.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                selected={selected === node.id}
                onPointerDownBody={onNodePointerDown}
                onStartResize={onStartResize}
                onStartConnect={onStartConnect}
                onCommitText={(id, text) =>
                  commit((d) => ({
                    ...d,
                    nodes: d.nodes.map((n) => (n.id === id ? { ...n, text } : n)),
                  }))
                }
                onOpenFile={(file) => openInWorkspace(file)}
              />
            ))}
          </div>
        )}
      </div>

      <NotePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={t("canvas.pickNote")}
        onPick={(notePath) => addFile(notePath)}
      />
    </div>
  );
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default function CanvasView() {
  const activeCanvas = useCanvas((s) => s.activeCanvas);
  if (!activeCanvas) return <CanvasGallery />;
  // Remount on path change so all per-canvas state resets cleanly.
  return <CanvasEditor key={activeCanvas} path={activeCanvas} />;
}
