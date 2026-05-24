import { useState } from "react";

import type { FolderNode, NoteSummary } from "../ipc/api";
import { useVault } from "../stores/vaultStore";

export function Sidebar({ onOpenSearch }: { onOpenSearch: () => void }) {
  const tree = useVault((s) => s.tree);
  const vaultPath = useVault((s) => s.vaultPath);
  const newNote = useVault((s) => s.newNote);
  const vaultName = vaultPath ? vaultPath.split("/").filter(Boolean).pop() : "Vault";

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900/40">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2.5">
        <span className="truncate text-sm font-medium text-neutral-200" title={vaultPath ?? ""}>
          {vaultName}
        </span>
        <div className="flex gap-1">
          <button
            title="Search (⌘K)"
            onClick={onOpenSearch}
            className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
          >
            ⌕
          </button>
          <button
            title="New note"
            onClick={() => void newNote("")}
            className="rounded px-1.5 py-0.5 text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
          >
            ＋
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {tree ? (
          <TreeChildren node={tree} depth={0} />
        ) : (
          <p className="px-3 py-2 text-xs text-neutral-600">Loading…</p>
        )}
      </div>
    </aside>
  );
}

function TreeChildren({ node, depth }: { node: FolderNode; depth: number }) {
  return (
    <>
      {node.children.map((child) => (
        <FolderRow key={child.path} node={child} depth={depth} />
      ))}
      {node.notes.map((note) => (
        <NoteRow key={note.path} note={note} depth={depth} />
      ))}
    </>
  );
}

function FolderRow({ node, depth }: { node: FolderNode; depth: number }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 py-1 pr-2 text-left text-sm text-neutral-400 hover:text-neutral-200"
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <span className="w-3 text-xs">{open ? "▾" : "▸"}</span>
        <span className="truncate">{node.name}</span>
      </button>
      {open && <TreeChildren node={node} depth={depth + 1} />}
    </div>
  );
}

function NoteRow({ note, depth }: { note: NoteSummary; depth: number }) {
  const activePath = useVault((s) => s.activePath);
  const openNote = useVault((s) => s.openNote);
  const active = activePath === note.path;
  return (
    <button
      onClick={() => void openNote(note.path)}
      title={note.path}
      className={`flex w-full items-center truncate py-1 pr-2 text-left text-sm ${
        active ? "bg-indigo-500/15 text-indigo-200" : "text-neutral-300 hover:bg-white/5"
      }`}
      style={{ paddingLeft: 24 + depth * 12 }}
    >
      <span className="truncate">{note.title}</span>
    </button>
  );
}
