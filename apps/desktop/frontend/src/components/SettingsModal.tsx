import { useEffect, useState } from "react";

import { api, type NoteTemplate } from "../ipc/api";
import { useTasks } from "../stores/taskStore";

interface Col {
  id: string;
  title: string;
}

const DEFAULT_COLS: Col[] = [
  { id: "backlog", title: "Backlog" },
  { id: "todo", title: "To Do" },
  { id: "in-progress", title: "In Progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
];

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [strategy, setStrategy] = useState("inbox");
  const [inboxPath, setInboxPath] = useState("_Inbox.md");
  const [defaultMode, setDefaultMode] = useState("list");
  const [columns, setColumns] = useState<Col[]>(DEFAULT_COLS);
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [tplName, setTplName] = useState("");
  const [tplContent, setTplContent] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSaved(false);
    void api
      .getPreferences()
      .then((p) => {
        const tv = p.taskView;
        setStrategy(tv?.taskCreation?.strategy ?? "inbox");
        setInboxPath(tv?.taskCreation?.inboxPath ?? "_Inbox.md");
        setDefaultMode(tv?.defaultMode ?? "list");
        const cols = (tv?.kanbanColumns ?? [])
          .map((c) => ({ id: c.id ?? "", title: c.title ?? "" }))
          .filter((c) => c.id !== "");
        setColumns(cols.length > 0 ? cols : DEFAULT_COLS);
      })
      .catch(() => {});
    void api.listTemplates().then(setTemplates).catch(() => {});
  }, [open]);

  if (!open) return null;

  const save = async () => {
    try {
      await api.setPreferences({
        taskView: { defaultMode, kanbanColumns: columns, taskCreation: { strategy, inboxPath } },
        fileTree: { sortBy: "name", sortDir: "asc" },
      });
      setSaved(true);
      void useTasks.getState().load();
    } catch {
      /* ignore */
    }
  };

  const createTpl = async () => {
    if (!tplName.trim()) return;
    try {
      await api.createTemplate(tplName.trim(), tplContent);
      setTplName("");
      setTplContent("");
      setTemplates(await api.listTemplates());
    } catch {
      /* ignore */
    }
  };

  const deleteTpl = async (id: string) => {
    try {
      await api.deleteTemplate(id);
      setTemplates(await api.listTemplates());
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-16"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl border border-neutral-700 bg-neutral-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-neutral-100">Settings</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200">
            ✕
          </button>
        </div>

        <Section title="Task creation">
          <Row label="Strategy">
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value)}
              className="rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
            >
              <option value="inbox">Inbox note</option>
              <option value="daily">Daily note</option>
              <option value="active-note">Active note</option>
            </select>
          </Row>
          <Row label="Inbox path">
            <input
              value={inboxPath}
              onChange={(e) => setInboxPath(e.target.value)}
              className="w-48 rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
            />
          </Row>
          <Row label="Default task view">
            <select
              value={defaultMode}
              onChange={(e) => setDefaultMode(e.target.value)}
              className="rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
            >
              <option value="list">List</option>
              <option value="kanban">Kanban</option>
              <option value="agenda">Agenda</option>
            </select>
          </Row>
        </Section>

        <Section title="Kanban columns">
          <div className="space-y-1">
            {columns.map((col, i) => (
              <div key={col.id} className="flex items-center gap-2">
                <input
                  value={col.title}
                  onChange={(e) =>
                    setColumns((c) => c.map((x, idx) => (idx === i ? { ...x, title: e.target.value } : x)))
                  }
                  className="flex-1 rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100"
                />
                <button
                  onClick={() => setColumns((c) => c.filter((_, idx) => idx !== i))}
                  className="text-neutral-500 hover:text-red-300"
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              onClick={() => setColumns((c) => [...c, { id: `col-${Date.now()}`, title: "New Column" }])}
              className="mt-1 text-xs text-indigo-400 hover:text-indigo-300"
            >
              + Add column
            </button>
          </div>
        </Section>

        <Section title="Templates">
          <div className="space-y-1">
            {templates.length === 0 && <p className="text-xs text-neutral-600">No templates yet.</p>}
            {templates.map((t) => (
              <div key={t.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-neutral-200">{t.name}</span>
                <button
                  onClick={() => void deleteTpl(t.id)}
                  className="text-neutral-500 hover:text-red-300"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 space-y-2 rounded-lg bg-neutral-950/50 p-2">
            <input
              value={tplName}
              onChange={(e) => setTplName(e.target.value)}
              placeholder="Template name"
              className="w-full rounded bg-neutral-800 px-2 py-1 text-sm text-neutral-100 placeholder:text-neutral-600"
            />
            <textarea
              value={tplContent}
              onChange={(e) => setTplContent(e.target.value)}
              placeholder="Template content (markdown)…"
              rows={3}
              className="w-full rounded bg-neutral-800 px-2 py-1 font-mono text-xs text-neutral-100 placeholder:text-neutral-600"
            />
            <button
              onClick={() => void createTpl()}
              className="rounded-md bg-indigo-500/90 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-400"
            >
              Add template
            </button>
          </div>
        </Section>

        <div className="mt-5 flex items-center justify-end gap-3">
          {saved && <span className="text-xs text-green-400">Saved</span>}
          <button
            onClick={() => void save()}
            className="rounded-md bg-indigo-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-400"
          >
            Save preferences
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <span className="text-sm text-neutral-300">{label}</span>
      {children}
    </div>
  );
}
