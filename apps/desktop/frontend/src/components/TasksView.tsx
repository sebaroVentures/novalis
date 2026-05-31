import { useEffect, useState } from "react";

import { Trans, useTranslation } from "react-i18next";

import type { Task } from "../ipc/api";
import { useSettings } from "../stores/settingsStore";
import { DEFAULT_COLUMNS, useTasks, type Column } from "../stores/taskStore";
import { useVault } from "../stores/vaultStore";

const ANNOTATION = /@(due|priority|status|repeat)\([^)]*\)/g;
const TAG = /(^|\s)#\w+/g;

function displayText(text: string): string {
  return text.replace(ANNOTATION, "").replace(TAG, "$1").replace(/\s+/g, " ").trim();
}

function seg(active: boolean): string {
  return `rounded-md px-2.5 py-1 text-xs ${
    active ? "bg-active text-fg" : "text-fg-muted hover:text-fg"
  }`;
}

export function TasksView() {
  const { t } = useTranslation(["tasks", "common"]);
  const mode = useTasks((s) => s.mode);
  const setMode = useTasks((s) => s.setMode);
  const filter = useTasks((s) => s.filter);
  const setFilter = useTasks((s) => s.setFilter);

  const modeLabels: Record<"list" | "kanban" | "agenda", string> = {
    list: t("common:taskModes.list"),
    kanban: t("common:taskModes.kanban"),
    agenda: t("common:taskModes.agenda"),
  };
  const filterLabels: Record<"open" | "all" | "completed", string> = {
    open: t("filter.open"),
    all: t("filter.all"),
    completed: t("filter.completed"),
  };

  useEffect(() => {
    void useTasks.getState().load();
  }, []);

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex gap-1">
          {/* eslint-disable-next-line i18next/no-literal-string -- mode ids (logic keys); labels come from modeLabels */}
          {(["list", "kanban", "agenda"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={seg(mode === m)}>
              {modeLabels[m]}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {/* eslint-disable-next-line i18next/no-literal-string -- filter ids (logic keys); labels come from filterLabels */}
          {(["open", "all", "completed"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={seg(filter === f)}>
              {filterLabels[f]}
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
  const { t } = useTranslation("tasks");
  const [text, setText] = useState("");
  const addTask = useTasks((s) => s.addTask);
  const activePath = useVault((s) => s.activePath);
  const taskCreation = useSettings((s) => s.prefs?.taskView?.taskCreation);
  const submit = () => {
    const notePath =
      taskCreation?.strategy === "active-note" && activePath ? activePath : undefined;
    void addTask(text, { notePath });
    setText("");
  };
  return (
    <div className="border-b border-border px-4 py-2">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder={t("addPlaceholder")}
        className="w-full rounded-md bg-surface px-3 py-1.5 text-sm text-fg outline-none ring-1 ring-border placeholder:text-fg-faint focus:ring-accent/50"
      />
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  const toggle = useTasks((s) => s.toggle);
  const openNote = useVault((s) => s.openNote);
  return (
    <div className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-hover">
      <input
        type="checkbox"
        checked={task.completed}
        onChange={() => void toggle(task.id)}
        className="mt-1 accent-[var(--accent)]"
      />
      <div className="min-w-0 flex-1">
        <div
          className={`text-sm ${task.completed ? "text-fg-faint line-through" : "text-fg"}`}
        >
          {displayText(task.text)}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
          {task.priority && <PriorityBadge priority={task.priority} />}
          {task.dueDate && <span>📅 {task.dueDate}</span>}
          {task.tags.map((tag) => (
            <span key={tag} className="text-fg-faint">
              #{tag}
            </span>
          ))}
          <button
            onClick={() => void openNote(task.sourceNote)}
            className="truncate hover:text-fg-muted"
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
  const { t } = useTranslation("tasks");
  const color =
    priority === "urgent"
      ? "bg-red-500/20 text-danger"
      : priority === "high"
        ? "bg-orange-500/20 text-orange-300"
        : priority === "medium"
          ? "bg-yellow-500/20 text-yellow-200"
          : "bg-surface-2 text-fg-muted";
  const labels: Record<string, string> = {
    urgent: t("priority.urgent"),
    high: t("priority.high"),
    medium: t("priority.medium"),
    low: t("priority.low"),
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${color}`}>
      {labels[priority] ?? priority}
    </span>
  );
}

function ListView() {
  const tasks = useTasks((s) => s.tasks);
  if (tasks.length === 0) return <Empty />;
  return (
    <div className="h-full overflow-y-auto p-3">
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} />
      ))}
    </div>
  );
}

function KanbanView() {
  const { t } = useTranslation("tasks");
  const tasks = useTasks((s) => s.tasks);
  const columns = useTasks((s) => s.columns);
  const setStatus = useTasks((s) => s.setStatus);
  const colIds = columns.map((c) => c.id);
  const columnFor = (task: Task) =>
    task.status && colIds.includes(task.status) ? task.status : columns[0]?.id;

  // Show the localized default title only while the column still carries its
  // seeded English default for that id; once the user renames it, the title is
  // their content and is shown verbatim in every language.
  const defaultTitleById = new Map(DEFAULT_COLUMNS.map((c) => [c.id, c.title]));
  const localizedDefault: Record<string, string> = {
    backlog: t("kanban.backlog"),
    todo: t("kanban.todo"),
    "in-progress": t("kanban.inProgress"),
    review: t("kanban.review"),
    done: t("kanban.done"),
  };
  const columnTitle = (col: Column) =>
    defaultTitleById.get(col.id) === col.title ? localizedDefault[col.id] ?? col.title : col.title;

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
          className="flex w-64 shrink-0 flex-col rounded-lg bg-surface/50"
        >
          <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
            {columnTitle(col)}
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-2">
            {tasks
              .filter((task) => !task.completed && columnFor(task) === col.id)
              .map((task) => (
                <div
                  key={task.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", task.id)}
                  className="cursor-grab rounded-md border border-border bg-surface p-2 text-sm text-fg"
                >
                  {displayText(task.text)}
                  {task.dueDate && <div className="mt-1 text-xs text-fg-subtle">📅 {task.dueDate}</div>}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type AgendaKey = "overdue" | "today" | "upcoming" | "noDate";

function AgendaView() {
  const { t } = useTranslation("tasks");
  const tasks = useTasks((s) => s.tasks).filter((task) => !task.completed);
  const groups = groupByDue(tasks);
  if (tasks.length === 0) return <Empty />;
  const labels: Record<AgendaKey, string> = {
    overdue: t("agenda.overdue"),
    today: t("agenda.today"),
    upcoming: t("agenda.upcoming"),
    noDate: t("agenda.noDate"),
  };
  return (
    <div className="h-full space-y-5 overflow-y-auto p-3">
      {groups.map(
        (g) =>
          g.tasks.length > 0 && (
            <div key={g.key}>
              <h3 className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                {labels[g.key]}
              </h3>
              {g.tasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </div>
          ),
      )}
    </div>
  );
}

function groupByDue(tasks: Task[]): { key: AgendaKey; tasks: Task[] }[] {
  const today = new Date().toISOString().slice(0, 10);
  const groups: Record<AgendaKey, Task[]> = { overdue: [], today: [], upcoming: [], noDate: [] };
  for (const task of tasks) {
    if (!task.dueDate) groups.noDate.push(task);
    else if (task.dueDate < today) groups.overdue.push(task);
    else if (task.dueDate === today) groups.today.push(task);
    else groups.upcoming.push(task);
  }
  return (["overdue", "today", "upcoming", "noDate"] as AgendaKey[]).map((key) => ({
    key,
    tasks: groups[key],
  }));
}

function Empty() {
  return (
    <div className="flex h-full items-center justify-center text-sm text-fg-faint">
      <Trans i18nKey="empty" ns="tasks">
        No tasks. Add one above, or write <code className="mx-1">- [ ] something</code> in a note.
      </Trans>
    </div>
  );
}
