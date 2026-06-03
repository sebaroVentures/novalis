import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { NovalisEditor } from "@novalis/editor";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  FileText,
  History,
  Link2,
  Loader2,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { api } from "../ipc/api";
import { useSettings } from "../stores/settingsStore";
import { useUi } from "../stores/uiStore";
import { useVault, type SaveState } from "../stores/vaultStore";
import { LinksPanel } from "./LinksPanel";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { VersionHistoryModal } from "./VersionHistoryModal";
import { WikiLinkHoverCard, type HoverTarget } from "./WikiLinkHoverCard";

// Device-local toggle for the links panel, persisted across sessions.
const LINKS_PANEL_KEY = "nv:linksPanelOpen";
function loadLinksOpen(): boolean {
  try {
    return localStorage.getItem(LINKS_PANEL_KEY) !== "0"; // default open
  } catch {
    return true;
  }
}
function saveLinksOpen(open: boolean): void {
  try {
    localStorage.setItem(LINKS_PANEL_KEY, open ? "1" : "0");
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

export function EditorPane() {
  const activeNote = useVault((s) => s.activeNote);
  const activePath = useVault((s) => s.activePath);
  const activeNoteVersion = useVault((s) => s.activeNoteVersion);
  const vaultPath = useVault((s) => s.vaultPath);
  const saveNote = useVault((s) => s.saveNote);
  const openNote = useVault((s) => s.openNote);
  const refreshTree = useVault((s) => s.refreshTree);
  const deleteActive = useVault((s) => s.deleteActive);
  const registerFlush = useVault((s) => s.registerFlush);
  const markDirty = useVault((s) => s.markDirty);
  const reloadActive = useVault((s) => s.reloadActive);
  const dismissExternalChange = useVault((s) => s.dismissExternalChange);
  const saveState = useVault((s) => s.saveState);
  const externalChange = useVault((s) => s.externalChange);
  const returnView = useUi((s) => s.returnView);
  const goBack = useUi((s) => s.goBack);
  const editorPrefs = useSettings((s) => s.prefs?.editor);
  const timer = useRef<number | null>(null);
  // The pending autosave, bound to the note it was typed in, so a flush always
  // writes to the correct path even mid-switch.
  const pending = useRef<{ path: string; content: string } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [linksOpen, setLinksOpen] = useState(loadLinksOpen);
  const [hovered, setHovered] = useState<HoverTarget | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const { t } = useTranslation(["editor", "common", "trash", "versions", "links"]);

  const toggleLinks = () =>
    setLinksOpen((v) => {
      saveLinksOpen(!v);
      return !v;
    });

  const split = useMemo(
    () => (activeNote ? splitFrontmatter(activeNote.content) : null),
    [activeNote],
  );

  // Persist the pending autosave now (to its own note). Called on debounce, and
  // by every navigation action (via the store registry) before `activePath`
  // changes — this is what closes the silent data-loss path.
  const flushPending = useCallback(async () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    if (!p) return;
    await saveNote(p.path, p.content);
    // Keep `pending` on a failed save so it can be retried; clear otherwise.
    if (useVault.getState().saveState !== "error") pending.current = null;
  }, [saveNote]);

  // Register the flush so navigation can drain pending edits to the right note.
  useEffect(() => {
    registerFlush(flushPending);
    return () => registerFlush(null);
  }, [registerFlush, flushPending]);

  // On note switch / unmount, cancel the debounce. The outgoing note's edits
  // were already flushed by the navigating action (and the editor's own blur
  // flush ran first), so there is nothing to lose here.
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
      pending.current = null;
      setHovered(null);
    },
    [activePath],
  );

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

  if (!activePath) {
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

  // Active note selected but its content isn't loaded yet (e.g. a OneDrive
  // online-only file still hydrating). Show a loader instead of the previous
  // note's stale content — never block on the read.
  if (!activeNote || activeNote.path !== activePath || !split) {
    const name = activePath.split("/").pop()?.replace(/\.md$/, "") ?? activePath;
    return (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-border px-5 py-2.5">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium text-fg">{name}</h2>
            <p className="truncate text-xs text-fg-faint">{activePath}</p>
          </div>
        </header>
        <div className="flex flex-1 items-center justify-center gap-2 text-fg-faint">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-sm">{t("common:loading")}</span>
        </div>
      </section>
    );
  }

  const onChange = (body: string) => {
    // A late flush from an editor unmounting due to a note switch: its content
    // was already persisted by the navigating flush, so ignore it rather than
    // resurrect dirty state on the newly-opened note.
    if (useVault.getState().activePath !== activePath) return;
    markDirty();
    pending.current = { path: activePath, content: split.fm + body };
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
      await openNote(path);
      await refreshTree();
    } catch (e) {
      // Surfaced via vaultStore.error in the host; nothing to do here.
      void e;
    }
  };

  const doExport = (format: "html" | "docx") => {
    setExportOpen(false);
    void api.exportNote(activePath, format).catch(() => {});
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {returnView && (
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
            <h2 className="truncate text-sm font-medium text-fg">{activeNote.title}</h2>
            <p className="truncate text-xs text-fg-faint">{activePath}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <SaveStatus state={saveState} onRetry={() => void flushPending()} />
          <button
            onClick={toggleLinks}
            title={linksOpen ? t("links:hide") : t("links:show")}
            aria-pressed={linksOpen}
            className={`rounded-md p-1.5 transition-colors hover:bg-active hover:text-fg ${
              linksOpen ? "bg-active text-fg" : "text-fg-muted"
            }`}
          >
            <Link2 size={15} />
          </button>
          <button
            onClick={() => setHistoryOpen(true)}
            title={t("versions:open")}
            className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-active hover:text-fg"
          >
            <History size={15} />
          </button>
          <div className="relative">
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
      {externalChange && (
        <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-2 px-5 py-2 text-xs">
          <span className="flex items-center gap-2 text-fg-muted">
            <AlertTriangle size={14} className="text-danger" />
            {t("externalChanged")}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => void reloadActive()}
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
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <NovalisEditor
            key={`${activePath}:${activeNoteVersion}`}
            value={split.body}
            onChange={onChange}
            onUploadImage={onUploadImage}
            resolveImageSrc={resolveImageSrc}
            onWikiLinkClick={onWikiLinkClick}
            onSearchLinkTargets={searchLinkTargets}
            onWikiLinkHover={onWikiLinkHover}
            onWikiLinkHoverEnd={onWikiLinkHoverEnd}
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
            }}
          />
        </div>
        {linksOpen && (
          <LinksPanel
            title={activeNote.title}
            path={activePath}
            onClose={toggleLinks}
          />
        )}
      </div>
      <WikiLinkHoverCard target={hovered} />
      <VersionHistoryModal
        open={historyOpen}
        path={activePath}
        onClose={() => setHistoryOpen(false)}
      />
      <ConfirmDialog
        open={confirmDelete}
        danger
        title={t("trash:trashConfirmTitle")}
        body={t("trash:trashConfirmBody", { name: activeNote.title })}
        confirmLabel={t("common:delete")}
        onConfirm={() => {
          setConfirmDelete(false);
          void deleteActive();
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
