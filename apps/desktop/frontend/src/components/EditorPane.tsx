import { useEffect, useMemo, useRef } from "react";

import { NovalisEditor } from "@novalis/editor";

import { useVault } from "../stores/vaultStore";

// Split a note into its YAML frontmatter block and body. The editor edits the
// body only; on save we re-attach the original frontmatter so titles/tags/
// created dates survive (the backend refreshes `modified`).
const FRONTMATTER = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/;
function splitFrontmatter(raw: string): { fm: string; body: string } {
  const m = raw.match(FRONTMATTER);
  return m ? { fm: m[1], body: m[2] } : { fm: "", body: raw };
}

export function EditorPane() {
  const activeNote = useVault((s) => s.activeNote);
  const activePath = useVault((s) => s.activePath);
  const saveNote = useVault((s) => s.saveNote);
  const deleteActive = useVault((s) => s.deleteActive);
  const timer = useRef<number | null>(null);

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

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-800 px-5 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-neutral-100">{activeNote.title}</h2>
          <p className="truncate text-xs text-neutral-600">{activePath}</p>
        </div>
        <button
          onClick={() => void deleteActive()}
          className="rounded-md px-2 py-1 text-xs text-neutral-400 transition hover:bg-red-500/10 hover:text-red-300"
        >
          Delete
        </button>
      </header>
      <NovalisEditor key={activePath} value={split.body} onChange={onChange} />
    </section>
  );
}
