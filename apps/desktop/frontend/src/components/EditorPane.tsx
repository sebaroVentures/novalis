import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  NovalisEditor,
  assignBlockId,
  extractHeadings,
  getMarkdown,
  type BlockRefResult,
  type Editor,
  type EmbedResult,
  type OutlineItem,
} from "@novalis/editor";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  Hash,
  History,
  Link2,
  ListTree,
  Loader2,
  Orbit,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, type PropertyValue } from "../ipc/api";
import { revealLabel } from "../lib/reveal";
import { useDismiss } from "../lib/useDismiss";
import { useIsMobile } from "../lib/useIsMobile";
import type { Pane } from "../lib/workspacePrefs";
import { useSettings } from "../stores/settingsStore";
import { useUi } from "../stores/uiStore";
import { useVault, type SaveState } from "../stores/vaultStore";
import { AiActionMenu } from "./ai/AiActionMenu";
import { AiMetaSuggestions } from "./ai/AiMetaSuggestions";
import { AmbientSuggestions } from "./ai/AmbientSuggestions";
import { RewriteReviewBar } from "./ai/RewriteReviewBar";
import { FindBar } from "./FindBar";
import { LinksPanel } from "./LinksPanel";
import { OutlinePanel } from "./OutlinePanel";
import { RelatedPanel } from "./RelatedPanel";
import { PropertiesPanel } from "./PropertiesPanel";
import { ChipInput } from "./ui/ChipInput";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { VersionHistoryModal } from "./VersionHistoryModal";
import { WikiLinkHoverCard, type HoverTarget } from "./WikiLinkHoverCard";

// Device-local right-rail panels (links / outline shown independently), persisted.
const RIGHT_PANEL_KEY = "nv:rightPanel";
interface RightPanels {
  links: boolean;
  outline: boolean;
  related: boolean;
}
function loadRightPanels(): RightPanels {
  try {
    const v = localStorage.getItem(RIGHT_PANEL_KEY);
    // Back-compat with the old mutually-exclusive string value.
    if (v === "links") return { links: true, outline: false, related: false };
    if (v === "outline") return { links: false, outline: true, related: false };
    if (v === "none") return { links: false, outline: false, related: false };
    if (v) {
      const p = JSON.parse(v) as Partial<RightPanels>;
      return { links: !!p.links, outline: !!p.outline, related: !!p.related };
    }
    // No stored preference. On a phone the panel is a full-screen overlay, so
    // it must start closed or it would hide the editor on first open; on
    // desktop it opens on linked references beside the editor.
    const phone = window.matchMedia("(max-width: 767px)").matches;
    return { links: !phone, outline: false, related: false };
  } catch {
    return { links: true, outline: false, related: false };
  }
}
function saveRightPanels(p: RightPanels): void {
  try {
    localStorage.setItem(RIGHT_PANEL_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

// Device-local "is the note's metadata strip (tags / aliases / properties /
// suggestions) expanded" bit (expanded default), persisted globally.
const META_OPEN_KEY = "nv:metaOpen";
function loadMetaOpen(): boolean {
  try {
    const v = localStorage.getItem(META_OPEN_KEY);
    if (v !== null) return v !== "0";
    // No stored preference: collapsed by default on phones (the strip is tall
    // and eats the editor on a small screen), open on desktop.
    return !window.matchMedia("(max-width: 767px)").matches;
  } catch {
    return true;
  }
}
function saveMetaOpen(open: boolean): void {
  try {
    localStorage.setItem(META_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

// Split a note into its YAML frontmatter block and body. The editor edits the
// body only; on save we re-attach the original frontmatter (the backend
// refreshes `modified`).
const FRONTMATTER = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/;
function splitFrontmatter(raw: string): { fm: string; body: string } {
  const m = raw.match(FRONTMATTER);
  return m ? { fm: m[1], body: m[2] } : { fm: "", body: raw };
}

// `![[image.png]]` embeds are classified + resolved entirely client-side — the
// `resolve_embed` backend only ever returns note/missing (image is a frontend
// concern via the vault image-src resolver).
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp"]);
function isImageTarget(target: string): boolean {
  return IMAGE_EXTS.has(target.split(".").pop()?.toLowerCase() ?? "");
}

/** Clickable folder segments leading to a note (root-first; excludes the file). */
function folderCrumbs(path: string): { label: string; path: string }[] {
  const parts = path.split("/");
  parts.pop();
  const out: { label: string; path: string }[] = [];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    out.push({ label: p, path: acc });
  }
  return out;
}

export function EditorPane({ pane }: { pane: Pane }) {
  // This pane's visible note: content comes from the per-path openNotes map
  // (NOT the focused-pane `activeNote` alias), so every pane renders its own
  // tab regardless of which pane is focused.
  const path = pane.activeTab;
  const note = useVault((s) => (path ? (s.openNotes.get(path) ?? null) : null));
  const epoch = useVault((s) => s.paneEpochs.get(pane.id) ?? 0);
  const focused = useUi((s) => s.workspace.focusedPaneId === pane.id);
  const vaultPath = useVault((s) => s.vaultPath);
  const saveNote = useVault((s) => s.saveNote);
  const loadNote = useVault((s) => s.loadNote);
  const revealPath = useVault((s) => s.revealPath);
  const revealInFileManager = useVault((s) => s.revealInFileManager);
  const refreshTree = useVault((s) => s.refreshTree);
  const deleteNote = useVault((s) => s.deleteNote);
  const renameItem = useVault((s) => s.renameItem);
  const registerFlush = useVault((s) => s.registerFlush);
  const markDirty = useVault((s) => s.markDirty);
  const reloadNote = useVault((s) => s.reloadNote);
  const dismissExternalChange = useVault((s) => s.dismissExternalChange);
  const reportError = useVault((s) => s.reportError);
  const saveState = useVault((s) => (path ? (s.saveStates.get(path) ?? "idle") : "idle"));
  const setNoteMeta = useVault((s) => s.setNoteMeta);
  const externalChange = useVault((s) => s.externalChange);
  const returnView = useUi((s) => s.returnView);
  const goBack = useUi((s) => s.goBack);
  const editorPrefs = useSettings((s) => s.prefs?.editor);
  const timer = useRef<number | null>(null);
  // The pending autosave, bound to the note it was typed in, so a flush always
  // writes to the correct path even mid-switch.
  const pending = useRef<{ path: string; content: string } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Non-null while the header title is being edited inline (holds the draft).
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [panels, setPanels] = useState<RightPanels>(loadRightPanels);
  const isMobile = useIsMobile();
  const [metaOpen, setMetaOpen] = useState(loadMetaOpen);
  const readingDefault = editorPrefs?.defaultReadingMode ?? false;
  // Per-note, ephemeral: reading mode resets to the configured default on every
  // note switch (never persisted per note — only the default is a preference).
  const [readingMode, setReadingMode] = useState(readingDefault);
  const [editor, setEditorInstance] = useState<Editor | null>(null);
  const [headings, setHeadings] = useState<OutlineItem[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [hovered, setHovered] = useState<HoverTarget | null>(null);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const hoverTimer = useRef<number | null>(null);
  const { t } = useTranslation(["editor", "common", "trash", "versions", "links"]);

  const togglePanel = (panel: "links" | "outline" | "related") =>
    setPanels((cur) => {
      const next = { ...cur, [panel]: !cur[panel] };
      saveRightPanels(next);
      return next;
    });

  const toggleMetaOpen = () =>
    setMetaOpen((v) => {
      saveMetaOpen(!v);
      return !v;
    });

  // Flush any pending edit before entering reading mode (belt-and-suspenders;
  // the editor's blur-flush also fires), then toggle the ephemeral state.
  const toggleReadingMode = () => {
    void flushPending();
    setReadingMode((v) => !v);
  };

  // Write tags/aliases via the frontmatter path. Flush the pending body autosave
  // first so it doesn't race the meta write on the same file.
  const commitMeta = async (meta: { tags?: string[]; aliases?: string[] }) => {
    if (!path) return;
    await flushPending();
    await setNoteMeta(path, meta);
  };

  // Apply an AI metadata suggestion. Read the latest tags/aliases from the live
  // store (not a render-scope prop) so rapid successive accepts can't drop each
  // other; `commitMeta` flushes the body autosave first, and `setProperty`
  // flushes internally — both write frontmatter only, never the body.
  const acceptSuggestedTag = async (tag: string) => {
    if (!path) return;
    const cur = useVault.getState().openNotes.get(path)?.frontmatter.tags ?? [];
    if (cur.some((x) => x.toLowerCase() === tag.toLowerCase())) return;
    await commitMeta({ tags: [...cur, tag] });
  };
  const acceptSuggestedAlias = async (alias: string) => {
    if (!path) return;
    const cur = useVault.getState().openNotes.get(path)?.frontmatter.aliases ?? [];
    if (cur.some((x) => x.toLowerCase() === alias.toLowerCase())) return;
    await commitMeta({ aliases: [...cur, alias] });
  };
  const acceptSuggestedProperty = async (key: string, value: PropertyValue) => {
    if (!path) return;
    await useVault.getState().setProperty(path, key, value);
  };

  // The pane's live editor instance, mirrored into a ref so cleanups can tell
  // whether the shared `activeEditor` is OURS before clearing it (another
  // pane's editor must never be clobbered by this pane unmounting).
  const editorRef = useRef<Editor | null>(null);
  const handleEditorReady = useCallback((ed: Editor) => {
    setEditorInstance(ed);
    editorRef.current = ed;
    // Share for palette "Insert template" — but only the FOCUSED pane's editor.
    const ui = useUi.getState();
    if (ui.workspace.focusedPaneId === pane.id) ui.setActiveEditor(ed);
  }, [pane.id]);

  // Re-publish this pane's editor whenever it gains focus; on focus LOSS clear
  // it if it is still ours, so focusing a pane with no mounted editor (empty /
  // loading) can't leave palette actions targeting the unfocused pane's note.
  useEffect(() => {
    const ui = useUi.getState();
    if (focused && editor) ui.setActiveEditor(editor);
    else if (!focused && editorRef.current && ui.activeEditor === editorRef.current) {
      ui.setActiveEditor(null);
    }
  }, [focused, editor]);

  useDismiss(exportRef, exportOpen, () => setExportOpen(false));

  const jumpToHeading = useCallback(
    (pos: number) => {
      if (!editor) return;
      editor.chain().focus().setTextSelection(pos + 1).scrollIntoView().run();
    },
    [editor],
  );

  // Rebuild the document outline (debounced) whenever the editor's doc changes.
  useEffect(() => {
    if (!editor) {
      setHeadings([]);
      return;
    }
    let htimer = 0;
    const recompute = () => {
      window.clearTimeout(htimer);
      htimer = window.setTimeout(() => setHeadings(extractHeadings(editor.state.doc)), 250);
    };
    recompute();
    editor.on("update", recompute);
    return () => {
      window.clearTimeout(htimer);
      editor.off("update", recompute);
    };
  }, [editor]);

  const split = useMemo(() => (note ? splitFrontmatter(note.content) : null), [note]);

  // Render-scope mirrors so the (stable) flush callback in the registry always
  // sees this pane's CURRENT path/frontmatter without re-registering.
  const pathRef = useRef(path);
  pathRef.current = path;
  const fmRef = useRef("");
  fmRef.current = split?.fm ?? "";
  // True when the live editor has doc changes NEWER than the debounced
  // `pending` snapshot. The editor's serialize debounce resets on every
  // keystroke, so during continuous typing `pending` lags arbitrarily far —
  // flushes and the mirror-on-save skip-check must not be blind to that.
  const liveDirty = useRef(false);
  // True between a discard (Reload-from-disk / external delete) and this
  // pane's editor remount: the doomed doc's late serializations (the editor's
  // own 200ms debounce can fire DURING the reload fetch) must not re-arm an
  // autosave of content the user already threw away.
  const discarded = useRef(false);

  useEffect(() => {
    if (!editor) return;
    // A fresh editor instance starts clean (its prior content was flushed or
    // deliberately discarded by whatever remounted it).
    liveDirty.current = false;
    // Only DOC changes count — `update` also fires for non-doc transactions
    // (e.g. setEditable), and a false positive here would make this pane claim
    // pending edits it doesn't have (blocking mirror-on-save convergence).
    const mark = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) liveDirty.current = true;
    };
    editor.on("update", mark);
    return () => {
      editor.off("update", mark);
    };
  }, [editor]);

  // Make sure this pane's note content is loaded (no-op when cached). The
  // focused pane is usually populated by openNote already; this is how a
  // NON-focused pane (split, restored layout) loads its tab.
  useEffect(() => {
    if (path) void loadNote(path);
  }, [path, loadNote]);

  // Persist the pending autosave now (to its own note). Called on debounce, and
  // by every navigation action (via the store registry) before this pane's
  // visible note changes — this is what closes the silent data-loss path.
  const flushPending = useCallback(async () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    // Discarded content (and anything typed into the doomed doc since) must
    // never be flushed — the remount resolves this state.
    if (discarded.current) return;
    let p = pending.current;
    // Edits newer than the debounced snapshot: serialize straight from the
    // live editor so a flush persists the TRUE current doc (a burst of
    // continuous typing may have produced no onChange at all yet).
    const ed = editorRef.current;
    if (liveDirty.current && ed && !ed.isDestroyed && pathRef.current) {
      try {
        p = { path: pathRef.current, content: fmRef.current + getMarkdown(ed) };
      } catch {
        /* fall back to the debounced snapshot */
      }
    }
    if (!p) return;
    liveDirty.current = false;
    // Retain as `pending` so a failed save keeps the content for retry.
    pending.current = p;
    // This pane is the typing source: other panes showing the note mirror on
    // save (they remount); this one never does.
    await saveNote(p.path, p.content, pane.id);
    // Keep `pending` on a failed save so it can be retried; clear otherwise.
    if ((useVault.getState().saveStates.get(p.path) ?? "idle") !== "error") pending.current = null;
  }, [saveNote, pane.id]);

  // Register the pane's autosave hooks so navigation can drain (flush), the
  // mirror-on-save path can spare a mid-edit pane (pendingPath), and external
  // deletes can drop a pending edit without resurrecting the file (discard).
  useEffect(() => {
    registerFlush(pane.id, {
      flush: flushPending,
      // Unflushed edits = a debounced snapshot OR live typing the serialize
      // debounce hasn't captured yet (mirror-on-save must spare both). A
      // discarded pane reports nothing: its doc is doomed and remount-bound.
      pendingPath: () =>
        discarded.current
          ? null
          : (pending.current?.path ?? (liveDirty.current ? pathRef.current : null)),
      discard: () => {
        if (timer.current) {
          window.clearTimeout(timer.current);
          timer.current = null;
        }
        pending.current = null;
        liveDirty.current = false;
        discarded.current = true;
      },
    });
    return () => registerFlush(pane.id, null);
  }, [registerFlush, flushPending, pane.id]);

  // An epoch bump means this pane ADOPTED content from elsewhere (external
  // reload, version restore, mirror-on-save): any pending autosave is based on
  // the replaced doc — drop it rather than let its timer resurrect stale
  // content over what the user (or disk) just chose.
  const lastEpoch = useRef(epoch);
  useEffect(() => {
    if (lastEpoch.current === epoch) return;
    lastEpoch.current = epoch;
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = null;
    liveDirty.current = false;
    discarded.current = false;
  }, [epoch]);

  // On note switch / unmount, cancel the debounce. Note switches were already
  // flushed by the navigating action — but a VIEW switch (notes → tasks/graph)
  // unmounts this pane with no flush in its path, so an unflushed edit here is
  // the last copy: persist it instead of discarding. In a DELETED subtree
  // React runs cleanups PARENT → CHILD, so this runs BEFORE the editor's own
  // unmount serialize-flush — serialize the live doc ourselves (the TipTap
  // instance is still alive at this point). The child's later flush re-arms an
  // identical pending whose orphaned save dedupes via lastRequest.
  useEffect(
    () => () => {
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      if (hoverTimer.current) {
        window.clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
      }
      let p = pending.current;
      const ed = editorRef.current;
      // pathRef === path distinguishes a true unmount from a tab switch within
      // the pane (there the render already advanced pathRef to the NEW path,
      // and the old editor's content must not be saved under it — the tab
      // switch was flushed by openNote anyway).
      if (path && liveDirty.current && ed && !ed.isDestroyed && pathRef.current === path) {
        try {
          p = { path, content: fmRef.current + getMarkdown(ed) };
        } catch {
          p = pending.current;
        }
      }
      if (p && !discarded.current) void saveNote(p.path, p.content, pane.id);
      pending.current = null;
      liveDirty.current = false;
      discarded.current = false;
      setHovered(null);
      setFindOpen(false);
      // Clear the shared editor only if it is OURS (another pane may have
      // published its own since) — and drop the local handles too: the old
      // TipTap instance is destroyed with the outgoing NovalisEditor, and a
      // focus-gain before the new one mounts must not republish a corpse.
      const ui = useUi.getState();
      if (editorRef.current && ui.activeEditor === editorRef.current) ui.setActiveEditor(null);
      editorRef.current = null;
      setEditorInstance(null);
    },
    // pane.id is constant per instance (panes render under key={pane.id}) and
    // saveNote is a stable store action — the cleanup still runs on note
    // switch/unmount only.
    [path, pane.id, saveNote],
  );

  // Reset reading mode to the configured default whenever the open note changes.
  useEffect(() => {
    setReadingMode(readingDefault);
  }, [path, readingDefault]);

  // Tag autocomplete source for the chip editor; refreshed per open note.
  useEffect(() => {
    let cancelled = false;
    void api
      .listTags()
      .then((ts) => {
        if (!cancelled) setTagSuggestions(ts.map((tc) => tc.tag));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path]);

  // NOTE: all hooks must stay above the early returns below, so the hook order
  // is identical across the loading → loaded transition (otherwise React throws
  // "rendered more hooks than during the previous render" and blanks the view).

  // `[[` autocomplete: title search over the index (no disk reads), mapped to
  // the editor's {title, path} shape.
  const searchLinkTargets = useCallback(async (query: string) => {
    try {
      const results = await api.quickSearch(query);
      return results.map((r) => ({ title: r.title, path: r.path }));
    } catch {
      return [];
    }
  }, []);

  // `((` autocomplete: tagged blocks from the block index, mapped to the
  // editor's BlockCandidate shape.
  const searchBlocks = useCallback(async (query: string) => {
    try {
      const hits = await api.searchBlocks(query);
      return hits.map((h) => ({ id: h.id, noteTitle: h.noteTitle, text: h.text }));
    } catch {
      return [];
    }
  }, []);

  // Resolve a `((^id))` reference to its block (note + text) for inline
  // rendering. A dangling id (its block was deleted) renders as "missing".
  const resolveBlock = useCallback(async (id: string): Promise<BlockRefResult> => {
    try {
      const r = await api.resolveBlock(id);
      if (r.found && r.notePath != null && r.text != null) {
        return { kind: "block", notePath: r.notePath, noteTitle: r.noteTitle ?? "", text: r.text };
      }
      return { kind: "missing" };
    } catch {
      return { kind: "missing" };
    }
  }, []);

  // `#` autocomplete: existing tags from the index, filtered by the typed query.
  const searchTags = useCallback(async (query: string) => {
    try {
      const tags = await api.listTags();
      const q = query.toLowerCase();
      return tags
        .map((t) => t.tag)
        .filter((tag) => tag.toLowerCase().includes(q))
        .slice(0, 20);
    } catch {
      return [];
    }
  }, []);

  // Hovering a `[[wikilink]]` shows a preview after a short delay (so passing
  // the cursor over a link doesn't flash a card).
  const onWikiLinkHover = useCallback((title: string, rect: DOMRect) => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHovered({ title, rect }), 350);
  }, []);
  const onWikiLinkHoverEnd = useCallback(() => {
    if (hoverTimer.current) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setHovered(null);
  }, []);

  if (!path) {
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-fg-faint">
        <FileText size={40} strokeWidth={1.25} className="text-fg-faint" />
        <div>
          <p className="text-sm font-medium text-fg-muted">{t("noteOpen")}</p>
          <p className="mt-1 text-xs text-fg-faint">{t("selectHint")}</p>
        </div>
      </section>
    );
  }

  // A tab is selected but its content isn't loaded yet (e.g. a OneDrive
  // online-only file still hydrating). Show a loader instead of stale
  // content — never block on the read.
  if (!note || note.path !== path || !split) {
    const name = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
    return (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-5 py-2.5">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-fg">{name}</h2>
            <p className="truncate text-xs text-fg-faint">{path}</p>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center gap-2 text-fg-faint">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">{t("common:loading")}</span>
        </div>
      </section>
    );
  }

  // Count of set metadata fields, shown beside the strip's header when collapsed
  // so hidden tags/aliases/properties stay discoverable.
  const metaCount =
    (note.frontmatter.tags?.length ?? 0) +
    (note.frontmatter.aliases?.length ?? 0) +
    (note.properties?.length ?? 0);

  const onChange = (body: string) => {
    // Between a discard and the remount that resolves it, every serialization
    // carries the doomed pre-discard doc — drop it (see `discarded`).
    if (discarded.current) return;
    // A late flush from an editor unmounting due to a tab switch: its content
    // was already persisted by the navigating flush, so ignore it rather than
    // resurrect dirty state on the newly-opened note. Per-pane: compare against
    // THIS pane's current active tab, not the focused pane's.
    const cur = useUi.getState().workspace.panes.find((p) => p.id === pane.id);
    if (cur?.activeTab !== path) return;
    // Likewise an editor being REPLACED by an epoch bump (same path): its
    // serialize-flush carries the pre-adoption doc — this closure captured the
    // pre-bump epoch, so a mismatch identifies (and drops) exactly that.
    if ((useVault.getState().paneEpochs.get(pane.id) ?? 0) !== epoch) return;
    markDirty(path);
    pending.current = { path, content: split.fm + body };
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void flushPending();
    }, editorPrefs?.autosaveMs ?? 600);
  };

  const onUploadImage = async (file: File): Promise<string | null> => {
    const bytes = Array.from(new Uint8Array(await file.arrayBuffer()));
    const ext = (file.name.split(".").pop() || file.type.split("/")[1] || "png").toLowerCase();
    try {
      return await api.savePastedImage(bytes, ext);
    } catch {
      return null;
    }
  };

  const resolveImageSrc = (src: string): string => {
    if (/^(https?:|data:|blob:|asset:|tauri:)/.test(src)) return src;
    if (!vaultPath) return src;
    const clean = src.replace(/^\.?\//, "");
    return convertFileSrc(`${vaultPath}/${clean}`);
  };

  const onWikiLinkClick = async (title: string) => {
    // Flush this note before navigating (openNote also flushes, but being
    // explicit keeps the editor's latest blur content safe either way).
    await flushPending();
    try {
      const path = await api.resolveOrCreateWikiLink(title);
      await refreshTree();
      // Open in (or activate) a tab in the focused pane (openInWorkspace loads it).
      useUi.getState().openInWorkspace(path);
    } catch (e) {
      // Surfaced via vaultStore.error in the host; nothing to do here.
      void e;
    }
  };

  // Resolve a `![[transclusion]]`: images by extension (client-side), notes via
  // the index. Read-only and never creates — a missing target yields a chip the
  // user can click (which routes through onWikiLinkClick to create + open).
  const onResolveEmbed = async (target: string): Promise<EmbedResult> => {
    if (isImageTarget(target)) return { kind: "image", src: resolveImageSrc(target) };
    try {
      const r = await api.resolveEmbed(target);
      if (r.kind === "note" && r.body != null) {
        return { kind: "note", path: r.path ?? "", title: r.title ?? target, body: r.body };
      }
      return { kind: "missing" };
    } catch {
      return { kind: "missing" };
    }
  };

  // Opening an embed (its "open note" affordance, or a missing-embed chip) routes
  // through the wikilink resolver, which creates on miss. Strip any `#section`
  // anchor first so `![[Note#Heading]]` opens/creates the base `Note` rather than
  // a literal `Note#Heading.md` file (section embeds are a later phase).
  const onOpenEmbed = (target: string) => onWikiLinkClick(target.split("#")[0].trim() || target);

  // Open the note a `((^id))` block reference points at. The BlockRef chip
  // passes the resolved note PATH (not a title), so open it directly.
  const onOpenBlock = async (notePath: string) => {
    await flushPending();
    useUi.getState().openInWorkspace(notePath);
  };

  // "Copy block reference": tag the block the cursor is in with a stable ` ^id`
  // marker (if it has none) and copy a `((^id))` reference to it. The marker is
  // written into this note round-trip-safely; the id survives later heading
  // renames and text edits, so the reference never silently breaks.
  const copyBlockRef = async () => {
    if (!editor) return;
    const id = assignBlockId(editor);
    if (!id) return;
    await flushPending();
    try {
      await navigator.clipboard.writeText(`((^${id}))`);
    } catch {
      /* clipboard denied — the marker is still inserted for manual reference */
    }
  };

  const doExport = (format: "html" | "docx") => {
    setExportOpen(false);
    void api.exportNote(path, format).catch((e) => reportError(e));
  };

  // Commit (or discard) an inline title edit from the header. Renaming a note
  // rewrites its frontmatter `title`, so flush pending body edits first to keep
  // the autosave and the rename from racing on the same file.
  const commitTitle = async () => {
    const draft = titleDraft;
    setTitleDraft(null);
    if (draft === null) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === note.title) return;
    await flushPending();
    await renameItem(path, "note", trimmed);
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {focused && returnView && (
            <button
              onClick={goBack}
              title={t("backToTasks")}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted transition-colors hover:bg-active hover:text-fg"
            >
              <ArrowLeft size={15} />
              <span className="hidden sm:inline">{t("backToTasks")}</span>
            </button>
          )}
          <div className="min-w-0">
            {titleDraft !== null ? (
              <input
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitTitle();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setTitleDraft(null);
                  }
                }}
                onBlur={() => void commitTitle()}
                className="w-full rounded bg-surface-2 px-1 py-0.5 text-sm font-medium text-fg outline-none ring-1 ring-accent/40"
              />
            ) : (
              <button
                onClick={() => setTitleDraft(note.title)}
                title={t("renameTitle")}
                className="block max-w-full truncate rounded text-left text-sm font-medium text-fg transition-colors hover:bg-hover"
              >
                {note.title}
              </button>
            )}
            {folderCrumbs(path).length > 0 ? (
              <div className="flex items-center gap-0.5 truncate text-xs text-fg-faint">
                {folderCrumbs(path).map((c, i) => (
                  <span key={c.path} className="flex items-center gap-0.5">
                    {i > 0 && <ChevronRight size={11} className="shrink-0 text-fg-faint/60" />}
                    <button
                      onClick={() => revealPath(c.path)}
                      className="truncate transition-colors hover:text-fg-muted"
                    >
                      {c.label}
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="truncate text-xs text-fg-faint">{path}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <SaveStatus state={saveState} onRetry={() => void flushPending()} />
          <button
            onClick={toggleReadingMode}
            title={t("readingMode")}
            aria-pressed={readingMode}
            className={`rounded-md p-1.5 transition-colors hover:bg-active hover:text-fg ${
              readingMode ? "bg-active text-fg" : "text-fg-muted"
            }`}
          >
            <BookOpen size={15} />
          </button>
          <button
            onClick={() => void copyBlockRef()}
            title={t("copyBlockRef")}
            className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-active hover:text-fg"
          >
            <Hash size={15} />
          </button>
          <button
            onClick={() => togglePanel("links")}
            title={panels.links ? t("links:hide") : t("links:show")}
            aria-pressed={panels.links}
            className={`rounded-md p-1.5 transition-colors hover:bg-active hover:text-fg ${
              panels.links ? "bg-active text-fg" : "text-fg-muted"
            }`}
          >
            <Link2 size={15} />
          </button>
          <button
            onClick={() => togglePanel("outline")}
            title={panels.outline ? t("links:hideOutline") : t("links:showOutline")}
            aria-pressed={panels.outline}
            className={`rounded-md p-1.5 transition-colors hover:bg-active hover:text-fg ${
              panels.outline ? "bg-active text-fg" : "text-fg-muted"
            }`}
          >
            <ListTree size={15} />
          </button>
          <button
            onClick={() => togglePanel("related")}
            title={panels.related ? t("links:related.hide") : t("links:related.show")}
            aria-pressed={panels.related}
            className={`rounded-md p-1.5 transition-colors hover:bg-active hover:text-fg ${
              panels.related ? "bg-active text-fg" : "text-fg-muted"
            }`}
          >
            <Orbit size={15} />
          </button>
          <button
            onClick={() => setHistoryOpen(true)}
            title={t("versions:open")}
            className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-active hover:text-fg"
          >
            <History size={15} />
          </button>
          <button
            onClick={() => {
              if (path) void revealInFileManager(path);
            }}
            title={revealLabel()}
            className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-active hover:text-fg"
          >
            <FolderOpen size={15} />
          </button>
          <AiActionMenu
            editor={editor}
            notePath={path}
            noteTitle={path ? (path.split("/").pop()?.replace(/\.md$/, "") ?? "") : ""}
          />
          <div ref={exportRef} className="relative">
            <button
              onClick={() => setExportOpen((v) => !v)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-active hover:text-fg"
            >
              {t("export")}
              <ChevronDown size={13} />
            </button>
            {exportOpen && (
              <div className="absolute right-0 z-10 mt-1 w-32 overflow-hidden rounded-lg border border-border-strong/80 bg-surface p-1 shadow-xl">
                <button
                  onClick={() => doExport("html")}
                  className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-fg transition-colors hover:bg-hover"
                >
                  {t("exportHtml")}
                </button>
                <button
                  onClick={() => doExport("docx")}
                  className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-fg transition-colors hover:bg-hover"
                >
                  {t("exportDocx")}
                </button>
              </div>
            )}
          </div>
          <button
            title={t("deleteNote")}
            onClick={() => setConfirmDelete(true)}
            className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-red-500/10 hover:text-danger"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </header>
      {externalChange === path && (
        <div
          data-external-banner=""
          className="flex items-center justify-between gap-3 border-b border-border bg-surface-2 px-5 py-2 text-xs"
        >
          <span className="flex items-center gap-2 text-fg-muted">
            <AlertTriangle size={14} className="text-danger" />
            {t("externalChanged")}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => void reloadNote(path)}
              className="rounded-md bg-accent px-2.5 py-1 font-medium text-accent-fg transition-colors hover:opacity-90"
            >
              {t("externalReload")}
            </button>
            <button
              onClick={() => dismissExternalChange()}
              className="rounded-md px-2.5 py-1 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            >
              {t("externalKeepMine")}
            </button>
          </div>
        </div>
      )}
      {findOpen && editor && <FindBar editor={editor} onClose={() => setFindOpen(false)} />}
      <RewriteReviewBar editor={editor} />
      <AmbientSuggestions
        path={path}
        noteTitle={note.title}
        editor={editor}
        enabled={editorPrefs?.ambientAi ?? false}
        knownTags={tagSuggestions}
        existingTags={note.frontmatter.tags ?? []}
        existingAliases={note.frontmatter.aliases ?? []}
        existingPropertyKeys={(note.properties ?? []).map((p) => p.key)}
        onAcceptTag={acceptSuggestedTag}
        onAcceptAlias={acceptSuggestedAlias}
        onAcceptProperty={acceptSuggestedProperty}
      />
      <div className="flex flex-col gap-1 border-b border-border/60 px-4 py-1.5">
        <button
          onClick={toggleMetaOpen}
          aria-expanded={metaOpen}
          className="flex items-center gap-1 self-start rounded px-0.5 text-[11px] uppercase tracking-wide text-fg-faint transition-colors hover:text-fg-muted"
        >
          {metaOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          {t("metadata")}
          {!metaOpen && metaCount > 0 && (
            <span className="tabular-nums">({metaCount})</span>
          )}
        </button>
        {/* Hidden, not unmounted, when collapsed: preserves in-progress chip
            drafts and unaccepted AI suggestions — the same "hide, don't destroy"
            contract the inner PropertiesPanel / AiMetaSuggestions collapses keep. */}
        <div className={metaOpen ? "flex flex-col gap-1" : "hidden"}>
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-[11px] uppercase tracking-wide text-fg-faint">
              {t("tags")}
            </span>
            <ChipInput
              values={note.frontmatter.tags ?? []}
              onChange={(next) => void commitMeta({ tags: next })}
              suggestions={tagSuggestions}
              placeholder={t("addTag")}
              ariaLabel={t("tags")}
              renderChip={(v) => `#${v}`}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-[11px] uppercase tracking-wide text-fg-faint">
              {t("aliases")}
            </span>
            <ChipInput
              values={note.frontmatter.aliases ?? []}
              onChange={(next) => void commitMeta({ aliases: next })}
              placeholder={t("addAlias")}
              ariaLabel={t("aliases")}
            />
          </div>
          <PropertiesPanel path={path} properties={note.properties ?? []} />
          <AiMetaSuggestions
            path={path}
            noteTitle={note.title}
            body={split.body}
            knownTags={tagSuggestions}
            existingTags={note.frontmatter.tags ?? []}
            existingAliases={note.frontmatter.aliases ?? []}
            existingPropertyKeys={(note.properties ?? []).map((p) => p.key)}
            onAcceptTag={acceptSuggestedTag}
            onAcceptAlias={acceptSuggestedAlias}
            onAcceptProperty={acceptSuggestedProperty}
          />
        </div>
      </div>
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <NovalisEditor
            key={`${pane.id}:${path}:${epoch}`}
            value={split.body}
            editable={!readingMode}
            onChange={onChange}
            onUploadImage={onUploadImage}
            resolveImageSrc={resolveImageSrc}
            onWikiLinkClick={onWikiLinkClick}
            onResolveEmbed={onResolveEmbed}
            onOpenNote={onOpenEmbed}
            onSearchLinkTargets={searchLinkTargets}
            onSearchTags={searchTags}
            onSearchBlocks={searchBlocks}
            onResolveBlock={resolveBlock}
            onOpenBlock={onOpenBlock}
            onWikiLinkHover={onWikiLinkHover}
            onWikiLinkHoverEnd={onWikiLinkHoverEnd}
            onEditorReady={handleEditorReady}
            onFindToggle={() => setFindOpen(true)}
            serializeMs={editorPrefs?.serializeMs ?? 200}
            spellCheck={editorPrefs?.spellcheck ?? true}
            labels={{
              placeholder: t("placeholder"),
              bold: t("bold"),
              italic: t("italic"),
              strike: t("strike"),
              heading1: t("heading1"),
              heading2: t("heading2"),
              heading3: t("heading3"),
              bulletList: t("bulletList"),
              taskList: t("taskList"),
              codeBlock: t("codeBlock"),
              blockquote: t("blockquote"),
              callout: t("callout"),
              horizontalRule: t("horizontalRule"),
              mermaidShowSource: t("mermaidShowSource"),
              mermaidShowDiagram: t("mermaidShowDiagram"),
              slashMath: t("slashMath"),
              slashMermaid: t("slashMermaid"),
              wikiCreateNew: t("wikiCreateNew"),
              embedLoading: t("embedLoading"),
              embedMissing: t("embedMissing"),
              embedSectionMissing: t("embedSectionMissing"),
              embedOpenNote: t("embedOpenNote"),
              suggestReject: t("suggestReject"),
              suggestRestore: t("suggestRestore"),
            }}
          />
        </div>
        {(panels.links || panels.outline || panels.related) && (
          <div
            className={
              isMobile
                ? "absolute inset-0 z-20 flex flex-col border-l border-border bg-app"
                : "flex w-72 shrink-0 flex-col border-l border-border"
            }
          >
            {panels.outline && (
              <OutlinePanel
                headings={headings}
                onJump={jumpToHeading}
                onClose={() => togglePanel("outline")}
                stacked
              />
            )}
            {panels.outline && panels.links && <div className="border-t border-border" />}
            {panels.links && (
              <LinksPanel
                title={note.title}
                path={path}
                onClose={() => togglePanel("links")}
                stacked
              />
            )}
            {(panels.outline || panels.links) && panels.related && (
              <div className="border-t border-border" />
            )}
            {panels.related && (
              <RelatedPanel path={path} onClose={() => togglePanel("related")} stacked />
            )}
          </div>
        )}
      </div>
      <WikiLinkHoverCard target={hovered} />
      <VersionHistoryModal
        open={historyOpen}
        path={path}
        onClose={() => setHistoryOpen(false)}
      />
      <ConfirmDialog
        open={confirmDelete}
        danger
        title={t("trash:trashConfirmTitle")}
        body={t("trash:trashConfirmBody", { name: note.title })}
        confirmLabel={t("common:delete")}
        onConfirm={() => {
          setConfirmDelete(false);
          void deleteNote(path);
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}

/** Small, unobtrusive save-state indicator in the editor header. */
function SaveStatus({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const { t } = useTranslation("editor");
  if (state === "saving") {
    return (
      <span className="flex items-center gap-1 text-xs text-fg-faint">
        <Loader2 size={12} className="animate-spin" />
        {t("saving")}
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="flex items-center gap-1 text-xs text-fg-faint">
        <Check size={12} />
        {t("saved")}
      </span>
    );
  }
  if (state === "dirty") {
    return (
      <span className="flex items-center gap-1 text-xs text-fg-faint">
        <span className="h-1.5 w-1.5 rounded-full bg-fg-faint" />
        {t("unsaved")}
      </span>
    );
  }
  if (state === "error") {
    return (
      <button
        onClick={onRetry}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-danger transition-colors hover:bg-red-500/10"
      >
        <AlertTriangle size={12} />
        {t("saveFailed")}
      </button>
    );
  }
  return null;
}
