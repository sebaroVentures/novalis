import { useEffect, useMemo, useRef, useState } from "react";

import { NovalisEditor } from "@novalis/editor";
import { convertFileSrc } from "@tauri-apps/api/core";

import { api } from "../ipc/api";
import { useVault } from "../stores/vaultStore";

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
  const vaultPath = useVault((s) => s.vaultPath);
  const saveNote = useVault((s) => s.saveNote);
  const deleteActive = useVault((s) => s.deleteActive);
  const timer = useRef<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const split = useMemo(
    () => (activeNote ? splitFrontmatter(activeNote.content) : null),
    [activeNote],
  );

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [activePath],
  );

  if (!activeNote || !activePath || !split) {
    return (
      <section className="flex flex-1 items-center justify-center text-neutral-600">
        <p>Select or create a note to start writing.</p>
      </section>
    );
  }

  const onChange = (body: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void saveNote(activePath, split.fm + body);
    }, 600);
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

  const doExport = (format: "html" | "docx") => {
    setExportOpen(false);
    void api.exportNote(activePath, format).catch(() => {});
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-800 px-5 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-neutral-100">{activeNote.title}</h2>
          <p className="truncate text-xs text-neutral-600">{activePath}</p>
        </div>
        <div className="flex items-center gap-1">
          <div className="relative">
            <button
              onClick={() => setExportOpen((v) => !v)}
              className="rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-white/5 hover:text-neutral-200"
            >
              Export ▾
            </button>
            {exportOpen && (
              <div className="absolute right-0 z-10 mt-1 w-32 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 shadow-xl">
                <button
                  onClick={() => doExport("html")}
                  className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/5"
                >
                  HTML
                </button>
                <button
                  onClick={() => doExport("docx")}
                  className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-white/5"
                >
                  Word (.docx)
                </button>
              </div>
            )}
          </div>
          <button
            onClick={() => void deleteActive()}
            className="rounded-md px-2 py-1 text-xs text-neutral-400 transition hover:bg-red-500/10 hover:text-red-300"
          >
            Delete
          </button>
        </div>
      </header>
      <NovalisEditor
        key={activePath}
        value={split.body}
        onChange={onChange}
        onUploadImage={onUploadImage}
        resolveImageSrc={resolveImageSrc}
      />
    </section>
  );
}
