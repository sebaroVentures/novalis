import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { convertFileSrc } from "@tauri-apps/api/core";
import {
  Copy,
  CornerDownRight,
  FileText,
  Highlighter,
  Link2,
  Loader2,
  NotebookPen,
  PanelRightClose,
  PanelRightOpen,
  Quote,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useTranslation } from "react-i18next";

// pdf.js is heavy; this whole component is React.lazy-loaded (App.tsx) and the
// vite manualChunks rule puts pdfjs-dist in its own `pdfjs` chunk, so nothing
// here touches the main bundle. The worker is bundled as a same-origin asset
// (`?url`) — never a CDN — so it works offline; pdf.js loads it as an ES module
// worker (CSP `worker-src 'self'`). See vite.config.ts + tauri.conf.json.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { api, type PdfAnnotations, type PdfHighlight } from "../ipc/api";
import "../lib/pdfTextLayer.css";
import {
  DEFAULT_HIGHLIGHT_COLOR,
  dedupeRects,
  formatHighlightLink,
  formatHighlightSnippet,
  HIGHLIGHT_COLOR_TOKENS,
  highlightColorHex,
  pdfBasename,
} from "../lib/pdf";
import { usePdf } from "../stores/pdfStore";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";
import { NotePickerModal } from "./NotePickerModal";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type PdfDoc = Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;

/** A pending text selection awaiting the "Highlight" confirmation popover. */
interface PendingSelection {
  page: number;
  rects: PdfHighlight["rects"];
  text: string;
  /** Viewport-space anchor for the floating popover (position: fixed). */
  x: number;
  y: number;
}

/** Full-screen PDF viewer + highlighter (feature W4.2). Store-driven overlay. */
export default function PdfViewer() {
  const path = usePdf((s) => s.path);
  const focusHighlightId = usePdf((s) => s.focusHighlightId);
  const close = usePdf((s) => s.close);
  const vaultPath = useVault((s) => s.vaultPath);
  const { t } = useTranslation(["pdf", "common"]);

  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [pageDims, setPageDims] = useState<{ width: number; height: number }[]>([]);
  const [scale, setScale] = useState(1.2);
  const [annotations, setAnnotations] = useState<PdfAnnotations>({ version: 1, highlights: [] });
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [error, setError] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<PdfHighlight | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLElement>>(new Map());
  const didFocus = useRef<string | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((m) => (m === msg ? null : m)), 2200);
  }, []);

  // ── Load the document ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!path || !vaultPath) return;
    setDoc(null);
    setPageDims([]);
    setError(false);
    pageRefs.current.clear();
    didFocus.current = null;
    // One full fetch over the asset protocol (disableRange/Stream) — robust for a
    // local file and independent of asset-protocol range support.
    const task = pdfjs.getDocument({
      url: convertFileSrc(`${vaultPath}/${path}`),
      disableRange: true,
      disableStream: true,
    });
    let cancelled = false;
    task.promise
      .then((d) => {
        // If unmounted/path-changed mid-load, the cleanup already called
        // task.destroy(), which tears down this document too — just bail.
        if (cancelled) return;
        setDoc(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [path, vaultPath]);

  // ── Load the sidecar annotations ──────────────────────────────────────────
  useEffect(() => {
    if (!path) return;
    setAnnotations({ version: 1, highlights: [] });
    void api
      .readPdfAnnotations(path)
      .then(setAnnotations)
      .catch(() => setAnnotations({ version: 1, highlights: [] }));
  }, [path]);

  // ── Reserve per-page layout (getViewport only — no canvas render yet), so the
  //    scroll height is correct up front and jump-to-highlight can target a page.
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      const dims: { width: number; height: number }[] = [];
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        if (cancelled) return;
        const vp = page.getViewport({ scale });
        dims.push({ width: vp.width, height: vp.height });
      }
      if (!cancelled) setPageDims(dims);
    })().catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, scale]);

  const registerPage = useCallback((n: number, el: HTMLElement | null) => {
    if (el) pageRefs.current.set(n, el);
    else pageRefs.current.delete(n);
  }, []);

  const jumpTo = useCallback((hl: PdfHighlight) => {
    setActiveId(hl.id);
    const el = pageRefs.current.get(hl.page);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  // Open on a specific highlight (from a `#hl=` back-link) once pages are laid out.
  useEffect(() => {
    if (!focusHighlightId || pageDims.length === 0) return;
    if (didFocus.current === focusHighlightId) return;
    const hl = annotations.highlights.find((h) => h.id === focusHighlightId);
    if (hl) {
      didFocus.current = focusHighlightId;
      jumpTo(hl);
    }
  }, [focusHighlightId, pageDims.length, annotations.highlights, jumpTo]);

  // Escape closes the viewer (unless a sub-modal is capturing it).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !linkTarget) {
        if (pending) setPending(null);
        else close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, pending, linkTarget]);

  // ── Persist helper: write the sidecar (empty set deletes it). ──────────────
  const persist = useCallback(
    (next: PdfAnnotations) => {
      setAnnotations(next);
      if (path) void api.writePdfAnnotations(path, next).catch(() => flash(t("viewer.error")));
    },
    [path, flash, t],
  );

  const updateHighlight = useCallback(
    (id: string, patch: Partial<PdfHighlight>) => {
      persist({
        ...annotations,
        highlights: annotations.highlights.map((h) => (h.id === id ? { ...h, ...patch } : h)),
      });
    },
    [annotations, persist],
  );

  const deleteHighlight = useCallback(
    (id: string) => {
      persist({ ...annotations, highlights: annotations.highlights.filter((h) => h.id !== id) });
    },
    [annotations, persist],
  );

  // ── Text selection → pending highlight ─────────────────────────────────────
  const onMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setPending(null);
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      setPending(null);
      return;
    }
    const anchorEl =
      sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
    const pageEl = anchorEl?.closest<HTMLElement>("[data-pdf-page]");
    const innerEl = pageEl?.querySelector<HTMLElement>(".pdf-page-inner");
    if (!pageEl || !innerEl) {
      setPending(null);
      return;
    }
    const pageNum = Number(pageEl.dataset.pdfPage);
    const box = innerEl.getBoundingClientRect();
    const clientRects = Array.from(sel.getRangeAt(0).getClientRects());
    const rects = dedupeRects(
      clientRects
        .filter(
          (r) =>
            r.width > 0 &&
            r.height > 0 &&
            r.left >= box.left - 2 &&
            r.right <= box.right + 2 &&
            r.top >= box.top - 2 &&
            r.bottom <= box.bottom + 2,
        )
        .map((r) => ({
          x: (r.left - box.left) / box.width,
          y: (r.top - box.top) / box.height,
          width: r.width / box.width,
          height: r.height / box.height,
        })),
    );
    if (rects.length === 0) {
      setPending(null);
      return;
    }
    const last = clientRects[clientRects.length - 1];
    setPending({ page: pageNum, rects, text, x: last.right, y: last.bottom });
  }, []);

  const commitHighlight = useCallback(
    (color: string) => {
      if (!pending) return;
      const hl: PdfHighlight = {
        id: crypto.randomUUID(),
        page: pending.page,
        color,
        text: pending.text,
        note: null,
        rects: pending.rects,
        linkedNotes: [],
        created: new Date().toISOString(),
      };
      persist({ ...annotations, highlights: [...annotations.highlights, hl] });
      window.getSelection()?.removeAllRanges();
      setPending(null);
      setActiveId(hl.id);
    },
    [pending, annotations, persist],
  );

  // ── Highlight → note linking ──────────────────────────────────────────────
  const linkToNote = useCallback(
    async (hl: PdfHighlight, target: string | null) => {
      if (!path) return;
      try {
        const notePath = await api.linkHighlightToNote(path, hl, target);
        const linked = Array.from(new Set([...(hl.linkedNotes ?? []), notePath]));
        updateHighlight(hl.id, { linkedNotes: linked });
        await useVault.getState().refreshTree();
        flash(t("panel.linkedToast", { note: pdfBasename(notePath) }));
      } catch {
        flash(t("viewer.error"));
      }
    },
    [path, updateHighlight, flash, t],
  );

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text).then(
        () => flash(t("panel.copied")),
        () => flash(t("viewer.error")),
      );
    },
    [flash, t],
  );

  const openLinkedNote = useCallback(
    (notePath: string) => {
      useUi.getState().setView("notes");
      useUi.getState().openInWorkspace(notePath);
      close();
    },
    [close],
  );

  const highlightsByPage = useMemo(() => {
    const map = new Map<number, PdfHighlight[]>();
    for (const h of annotations.highlights) {
      const arr = map.get(h.page) ?? [];
      arr.push(h);
      map.set(h.page, arr);
    }
    return map;
  }, [annotations.highlights]);

  const sortedHighlights = useMemo(
    () =>
      [...annotations.highlights].sort(
        (a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0),
      ),
    [annotations.highlights],
  );

  const name = path ? pdfBasename(path) : "";

  return (
    <div className="fixed inset-0 z-50 flex bg-app text-fg">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <header className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
          <FileText size={16} className="shrink-0 text-fg-subtle" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
          {doc && (
            <span className="hidden shrink-0 text-xs tabular-nums text-fg-faint sm:block">
              {t("viewer.pageOf", { page: doc.numPages, total: doc.numPages })}
            </span>
          )}
          <div className="mx-1 flex items-center gap-0.5">
            <button
              onClick={() => setScale((s) => Math.max(MIN_SCALE, +(s - 0.2).toFixed(2)))}
              title={t("viewer.zoomOut")}
              className="rounded p-1.5 text-fg-muted transition-colors hover:bg-hover"
            >
              <ZoomOut size={16} />
            </button>
            <button
              onClick={() => setScale((s) => Math.min(MAX_SCALE, +(s + 0.2).toFixed(2)))}
              title={t("viewer.zoomIn")}
              className="rounded p-1.5 text-fg-muted transition-colors hover:bg-hover"
            >
              <ZoomIn size={16} />
            </button>
          </div>
          <button
            onClick={() => setPanelOpen((v) => !v)}
            title={t("viewer.togglePanel")}
            aria-pressed={panelOpen}
            className="rounded p-1.5 text-fg-muted transition-colors hover:bg-hover"
          >
            {panelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
          </button>
          <button
            onClick={close}
            title={t("viewer.close")}
            className="rounded p-1.5 text-fg-muted transition-colors hover:bg-hover"
          >
            <X size={16} />
          </button>
        </header>

        {/* Pages */}
        <div
          ref={scrollRef}
          onMouseUp={onMouseUp}
          className="relative min-h-0 flex-1 overflow-auto bg-surface-2/40 py-4"
        >
          {error ? (
            <div className="flex h-full items-center justify-center text-sm text-danger">
              {t("viewer.error")}
            </div>
          ) : !doc || pageDims.length === 0 ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-fg-faint">
              <Loader2 size={15} className="animate-spin" />
              {t("viewer.loading")}
            </div>
          ) : (
            pageDims.map((dims, i) => (
              <PdfPage
                key={i + 1}
                doc={doc}
                pageNumber={i + 1}
                dims={dims}
                scale={scale}
                highlights={highlightsByPage.get(i + 1) ?? []}
                activeId={activeId}
                registerPage={registerPage}
              />
            ))
          )}
        </div>

        {/* Selection → Highlight popover (fixed to the selection) */}
        {pending && (
          <div
            style={{ left: pending.x + 4, top: pending.y + 6 }}
            className="fixed z-[55] flex items-center gap-1 rounded-lg border border-border-strong bg-surface px-1.5 py-1 shadow-xl"
          >
            {HIGHLIGHT_COLOR_TOKENS.map((token) => (
              <button
                key={token}
                onClick={() => commitHighlight(token)}
                title={t("viewer.highlight")}
                className="h-5 w-5 rounded-full border border-black/10 transition-transform hover:scale-110"
                style={{ backgroundColor: highlightColorHex(token) }}
              />
            ))}
            <button
              onClick={() => commitHighlight(DEFAULT_HIGHLIGHT_COLOR)}
              className="ml-1 flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg"
            >
              <Highlighter size={13} />
              {t("viewer.highlight")}
            </button>
          </div>
        )}
      </div>

      {/* Highlights panel */}
      {panelOpen && (
        <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-surface">
          <header className="flex items-center gap-1.5 border-b border-border px-3 py-2 text-xs font-medium text-fg-muted">
            <Highlighter size={14} />
            {t("panel.title")}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {sortedHighlights.length === 0 && (
              <p className="px-1 py-2 text-xs text-fg-faint">{t("panel.empty")}</p>
            )}
            {sortedHighlights.map((hl) => (
              <HighlightRow
                key={hl.id}
                hl={hl}
                active={activeId === hl.id}
                onJump={() => jumpTo(hl)}
                onCopyLink={() => copy(formatHighlightLink(path ?? "", hl))}
                onCopyQuote={() => copy(formatHighlightSnippet(path ?? "", hl))}
                onAddToNote={() => void linkToNote(hl, null)}
                onLinkToNote={() => setLinkTarget(hl)}
                onDelete={() => deleteHighlight(hl.id)}
                onSaveNote={(note) => updateHighlight(hl.id, { note: note || null })}
                onOpenNote={openLinkedNote}
              />
            ))}
          </div>
        </aside>
      )}

      {toast && (
        <div className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2 rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-xs text-fg shadow-xl">
          {toast}
        </div>
      )}

      {linkTarget && (
        <NotePickerModal
          open
          onClose={() => setLinkTarget(null)}
          onPick={(notePath) => void linkToNote(linkTarget, notePath)}
          title={t("panel.linkPickerTitle")}
          recentPaths={useVault.getState().recent}
        />
      )}
    </div>
  );
}

// ── One page: reserves layout, renders canvas + selectable text layer lazily ──

interface PdfPageProps {
  doc: PdfDoc;
  pageNumber: number;
  dims: { width: number; height: number };
  scale: number;
  highlights: PdfHighlight[];
  activeId: string | null;
  registerPage: (n: number, el: HTMLElement | null) => void;
}

function PdfPage({
  doc,
  pageNumber,
  dims,
  scale,
  highlights,
  activeId,
  registerPage,
}: PdfPageProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    registerPage(pageNumber, wrapRef.current);
    return () => registerPage(pageNumber, null);
  }, [pageNumber, registerPage]);

  // Render only when scrolled near the viewport (prerender a screen ahead).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true);
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Draw the canvas + place the text layer for selection. Re-runs on scale.
  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
    const textContainer = textRef.current;
    if (!canvas || !textContainer) return;
    let cancelled = false;
    let renderTask: ReturnType<Awaited<ReturnType<PdfDoc["getPage"]>>["render"]> | null = null;

    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.ceil(viewport.width * dpr);
      canvas.height = Math.ceil(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      // pdf.js 6 renders from the canvas element itself (deriving the 2D
      // context); the DPR transform keeps it crisp on hi-dpi displays.
      renderTask = page.render({
        canvas,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      try {
        await renderTask.promise;
      } catch {
        return; // cancelled (scale change / unmount)
      }
      if (cancelled) return;

      // Selectable text layer, positioned over the canvas.
      textContainer.replaceChildren();
      textContainer.style.setProperty("--total-scale-factor", String(scale));
      textContainer.style.width = `${viewport.width}px`;
      textContainer.style.height = `${viewport.height}px`;
      const textContent = await page.getTextContent();
      if (cancelled) return;
      const textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: textContainer, viewport });
      await textLayer.render();
    })().catch(() => {
      /* a render race on fast scroll/zoom — the next effect run redraws */
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [visible, doc, pageNumber, scale]);

  return (
    <div
      ref={wrapRef}
      data-pdf-page={pageNumber}
      className="mx-auto mb-4 bg-white shadow-md ring-1 ring-black/5"
      style={{ width: dims.width, height: dims.height }}
    >
      <div className="pdf-page-inner relative" style={{ width: dims.width, height: dims.height }}>
        <canvas ref={canvasRef} className="block" />
        <div ref={textRef} className="textLayer" />
        {/* Highlight overlay — purely visual (pointer-events none) so it never
            blocks text selection over an existing highlight. */}
        <div className="pointer-events-none absolute inset-0">
          {highlights.map((hl) =>
            hl.rects.map((r, i) => (
              <div
                key={`${hl.id}:${i}`}
                className="absolute rounded-[2px]"
                style={{
                  left: (r.x ?? 0) * dims.width,
                  top: (r.y ?? 0) * dims.height,
                  width: (r.width ?? 0) * dims.width,
                  height: (r.height ?? 0) * dims.height,
                  backgroundColor: highlightColorHex(hl.color),
                  opacity: activeId === hl.id ? 0.55 : 0.32,
                  outline: activeId === hl.id ? "1.5px solid rgba(0,0,0,0.35)" : undefined,
                }}
              />
            )),
          )}
        </div>
      </div>
    </div>
  );
}

// ── One row in the highlights panel ───────────────────────────────────────────

interface HighlightRowProps {
  hl: PdfHighlight;
  active: boolean;
  onJump: () => void;
  onCopyLink: () => void;
  onCopyQuote: () => void;
  onAddToNote: () => void;
  onLinkToNote: () => void;
  onDelete: () => void;
  onSaveNote: (note: string) => void;
  onOpenNote: (notePath: string) => void;
}

function HighlightRow({
  hl,
  active,
  onJump,
  onCopyLink,
  onCopyQuote,
  onAddToNote,
  onLinkToNote,
  onDelete,
  onSaveNote,
  onOpenNote,
}: HighlightRowProps) {
  const { t } = useTranslation("pdf");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(hl.note ?? "");

  return (
    <div
      className={`mb-1.5 rounded-md border px-2 py-1.5 transition-colors ${
        active ? "border-accent/50 bg-active" : "border-border/60 bg-surface-2/40"
      }`}
    >
      <button onClick={onJump} title={t("panel.jump")} className="flex w-full gap-2 text-left">
        <span
          className="mt-0.5 h-3 w-3 shrink-0 rounded-full"
          style={{ backgroundColor: highlightColorHex(hl.color) }}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[10px] font-medium uppercase tracking-wide text-fg-faint">
            {t("panel.title")} · p.{hl.page}
          </span>
          <span className="line-clamp-3 text-xs text-fg">{hl.text}</span>
          {hl.note && !editing && (
            <span className="mt-0.5 line-clamp-2 text-[11px] italic text-fg-muted">{hl.note}</span>
          )}
        </span>
      </button>

      {editing ? (
        <div className="mt-1.5">
          <textarea
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("panel.notePlaceholder")}
            rows={2}
            className="w-full resize-none rounded border border-border bg-surface px-1.5 py-1 text-[11px] text-fg outline-none focus:border-accent/50"
          />
          <div className="mt-1 flex justify-end gap-1">
            <button
              onClick={() => setEditing(false)}
              className="rounded px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-hover"
            >
              {t("panel.cancel")}
            </button>
            <button
              onClick={() => {
                onSaveNote(draft.trim());
                setEditing(false);
              }}
              className="rounded bg-accent px-1.5 py-0.5 text-[11px] font-medium text-accent-fg"
            >
              {t("panel.save")}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-1 flex flex-wrap items-center gap-0.5">
          <RowAction icon={<NotebookPen size={13} />} label={t("panel.addToNote")} onClick={onAddToNote} />
          <RowAction icon={<Link2 size={13} />} label={t("panel.linkToNote")} onClick={onLinkToNote} />
          <RowAction icon={<Copy size={13} />} label={t("panel.copyLink")} onClick={onCopyLink} />
          <RowAction icon={<Quote size={13} />} label={t("panel.copyQuote")} onClick={onCopyQuote} />
          <RowAction
            icon={<NotebookPen size={13} />}
            label={t("panel.addNote")}
            onClick={() => {
              setDraft(hl.note ?? "");
              setEditing(true);
            }}
          />
          <RowAction icon={<Trash2 size={13} />} label={t("panel.delete")} onClick={onDelete} danger />
        </div>
      )}

      {(hl.linkedNotes?.length ?? 0) > 0 && (
        <div className="mt-1.5 flex flex-col gap-0.5 border-t border-border/50 pt-1.5">
          <span className="text-[10px] uppercase tracking-wide text-fg-faint">
            {t("panel.linkedTo")}
          </span>
          {hl.linkedNotes?.map((notePath) => (
            <button
              key={notePath}
              onClick={() => onOpenNote(notePath)}
              title={notePath}
              className="flex items-center gap-1 truncate text-left text-[11px] text-accent hover:underline"
            >
              <CornerDownRight size={11} className="shrink-0" />
              <span className="truncate">{pdfBasename(notePath)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RowAction({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`rounded p-1 transition-colors hover:bg-hover ${
        danger ? "text-fg-faint hover:text-danger" : "text-fg-faint hover:text-fg"
      }`}
    >
      {icon}
    </button>
  );
}
