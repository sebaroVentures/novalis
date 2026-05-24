import { useEffect, useState } from "react";

import type { Task } from "../ipc/api";
import { useTasks } from "../stores/taskStore";
import { useVault } from "../stores/vaultStore";

const ANNOTATION = /@(due|priority|status|repeat)\([^)]*\)/g;
const TAG = /(^|\s)#\w+/g;

function displayText(text: string): string {
  return text.replace(ANNOTATION, "").replace(TAG, "$1").replace(/\s+/g, " ").trim();
}

function seg(active: boolean): string {
  return `rounded-md px-2.5 py-1 text-xs ${
    active ? "bg-white/10 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"
  }`;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function TasksView() {
  const mode = useTasks((s) => s.mode);
  const setMode = useTasks((s) => s.setMode);
  const filter = useTasks((s) => s.filter);
  const setFilter = useTasks((s) => s.setFilter);

  useEffect(() => {
    void useTasks.getState().load();
  }, []);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-neutral-800 px-4 py-2">
        <div className="flex gap-1">
          {(["list", "kanban", "agenda"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={seg(mode === m)}>
              {cap(m)}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(["open", "all", "completed"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={seg(filter === f)}>
              {cap(f)}
            </button>
          ))}
        </div>
      </header>
      <NewTaskBar />
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === "list" ? <ListView /> : mode === "kanban" ? <KanbanView /> : <AgendaView />}
      </div>
    </section>
  );
}

function NewTaskBar() {
  const [text, setText] = useState("");
  const addTask = useTasks((s) => s.addTask);
  const submit = () => {
    void addTask(text);
    setText("");
  };
  return (
    <div className="border-b border-neutral-800 px-4 py-2">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder="Add a task…  (e.g. Ship release @due(2026-06-01) @priority(high))"
        className="w-full rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100 outline-none ring-1 ring-neutral-800 placeholder:text-neutral-600 focus:ring-indigo-500/50"
      />
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  const toggle = useTasks((s) => s.toggle);
  const openNote = useVault((s) => s.openNote);
  return (
    <div className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-white/5">
      <input
        type="checkbox"
        checked={task.completed}
        onChange={() => void toggle(task.id)}
        className="mt-1 accent-indigo-500"
      />
      <div className="min-w-0 flex-1">
        <div
          className={`text-sm ${task.completed ? "text-neutral-600 line-through" : "text-neutral-200"}`}
        >
          {displayText(task.text)}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          {task.priority && <PriorityBadge priority={task.priority} />}
          {task.dueDate && <span>📅 {task.dueDate}</span>}
          {task.tags.map((t) => (
            <span key={t} className="text-neutral-600">
              #{t}
            </span>
          ))}
          <button
            onClick={() => void openNote(task.sourceNote)}
            className="truncate hover:text-neutral-300"
            title={task.sourceNote}
          >
            {task.sourceNote}
          </button>
        </div>
      </div>
    </div>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const color =
    priority === "urgent"
      ? "bg-red-500/20 text-red-300"
      : priority === "high"
        ? "bg-orange-500/20 text-orange-300"
        : priority === "medium"
          ? "bg-yellow-500/20 text-yellow-200"
          : "bg-neutral-500/20 text-neutral-300";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${color}`}>{priority}</span>;
}

function ListView() {
  const tasks = useTasks((s) => s.tasks);
  if (tasks.length === 0) return <Empty />;
  return (
    <div className="h-full overflow-y-auto p-3">
      {tasks.map((t) => (
        <TaskRow key={t.id} task={t} />
      ))}
    </div>
  );
}

function KanbanView() {
  const tasks = useTasks((s) => s.tasks);
  const columns = useTasks((s) => s.columns);
  const setStatus = useTasks((s) => s.setStatus);
  const colIds = columns.map((c) => c.id);
  const columnFor = (t: Task) =>
    t.status && colIds.includes(t.status) ? t.status : columns[0]?.id;

  return (
    <div className="flex h-full gap-3 overflow-x-auto p-3">
      {columns.map((col) => (
        <div
          key={col.id}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const id = e.dataTransfer.getData("text/plain");
            if (id) void setStatus(id, col.id);
          }}
          className="flex w-64 shrink-0 flex-col rounded-lg bg-neutral-900/50"
        >
          <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
            {col.title}
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-2">
            {tasks
              .filter((t) => !t.completed && columnFor(t) === col.id)
              .map((t) => (
                <div
                  key={t.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)}
                  className="cursor-grab rounded-md border border-neutral-800 bg-neutral-900 p-2 text-sm text-neutral-200"
                >
                  {displayText(t.text)}
                  {t.dueDate && <div className="mt-1 text-xs text-neutral-500">📅 {t.dueDate}</div>}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AgendaView() {
  const tasks = useTasks((s) => s.tasks).filter((t) => !t.completed);
  const groups = groupByDue(tasks);
  if (tasks.length === 0) return <Empty />;
  return (
    <div className="h-full space-y-5 overflow-y-auto p-3">
      {groups.map(
        (g) =>
          g.tasks.length > 0 && (
            <div key={g.label}>
              <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                {g.label}
              </h3>
              {g.tasks.map((t) => (
                <TaskRow key={t.id} task={t} />
              ))}
            </div>
          ),
      )}
    </div>
  );
}

function groupByDue(tasks: Task[]): { label: string; tasks: Task[] }[] {
  const today = new Date().toISOString().slice(0, 10);
  const groups: Record<string, Task[]> = { Overdue: [], Today: [], Upcoming: [], "No date": [] };
  for (const t of tasks) {
    if (!t.dueDate) groups["No date"].push(t);
    else if (t.dueDate < today) groups.Overdue.push(t);
    else if (t.dueDate === today) groups.Today.push(t);
    else groups.Upcoming.push(t);
  }
  return ["Overdue", "Today", "Upcoming", "No date"].map((label) => ({
    label,
    tasks: groups[label],
  }));
}

function Empty() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-neutral-600">
      No tasks. Add one above, or write <code className="mx-1">- [ ] something</code> in a note.
    </div>
  );
}
