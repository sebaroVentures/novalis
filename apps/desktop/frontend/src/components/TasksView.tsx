import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, FolderInput, Plus, Search, X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import type { Task } from "../ipc/api";
import { COLOR_HEX } from "../lib/colors";
import { displayText, noteTitleFromPath, tagColor, topFolderFromPath } from "../lib/taskDisplay";
import { useSettings } from "../stores/settingsStore";
import {
  allProjects,
  allTags,
  boardFilterActive,
  DEFAULT_COLUMNS,
  filterTasks,
  topFolders,
  useTasks,
  type BoardGroupBy,
  type Column,
  type DueBucket,
} from "../stores/taskStore";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";
import { NotePickerModal } from "./NotePickerModal";
import { TaskCardMenu } from "./TaskCardMenu";
import { DueBadge, PriorityBadge, SubtaskBadge, TagChip } from "./TaskBadges";

function seg(active: boolean): string {
  return `rounded-md px-2.5 py-1 text-xs ${
    active ? "bg-active text-fg" : "text-fg-muted hover:text-fg"
  }`;
}

const selectCls =
  "rounded-md bg-surface-2 px-2 py-1 text-xs text-fg outline-none ring-1 ring-border focus:ring-accent/50";

export function TasksView() {
  const { t } = useTranslation(["tasks", "common"]);
  const mode = useTasks((s) => s.mode);
  const setMode = useTasks((s) => s.setMode);
  const filter = useTasks((s) => s.filter);
  const setFilter = useTasks((s) => s.setFilter);
  const error = useTasks((s) => s.error);

  const modeLabels: Record<"kanban" | "list", string> = {
    kanban: t("common:taskModes.kanban"),
    list: t("common:taskModes.list"),
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
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex gap-1">
          {/* eslint-disable-next-line i18next/no-literal-string -- mode ids (logic keys); labels come from modeLabels */}
          {(["kanban", "list"] as const).map((m) => (
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
      <FilterBar />
      {error && (
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2 text-sm text-danger">
          <span>{t("loadError")}</span>
          <button
            onClick={() => void useTasks.getState().load()}
            className="shrink-0 rounded-md px-2 py-1 text-xs ring-1 ring-danger/50 transition-colors hover:bg-danger/10"
          >
            {t("common:retry")}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {mode === "kanban" ? <KanbanView /> : <ListView />}
      </div>
      <TaskCardMenu />
    </section>
  );
}

function NewTaskBar() {
  const { t } = useTranslation("tasks");
  const [text, setText] = useState("");
  const [picking, setPicking] = useState(false);
  const addTask = useTasks((s) => s.addTask);
  const pinnedNotePath = useTasks((s) => s.pinnedNotePath);
  const setPinnedNotePath = useTasks((s) => s.setPinnedNotePath);
  const recentDestinations = useTasks((s) => s.recentDestinations);
  const pushRecentDestination = useTasks((s) => s.pushRecentDestination);
  const activePath = useVault((s) => s.activePath);
  const taskCreation = useSettings((s) => s.prefs?.taskView?.taskCreation);
  const submit = () => {
    // Session pin wins over the creation strategy (active note / inbox).
    const notePath =
      pinnedNotePath ??
      (taskCreation?.strategy === "active-note" && activePath ? activePath : undefined);
    void addTask(text, { notePath });
    setText("");
  };
  const strategy = taskCreation?.strategy ?? "inbox";
  const destName = pinnedNotePath
    ? noteTitleFromPath(pinnedNotePath)
    : strategy === "active-note"
      ? t("dest.activeNote")
      : strategy === "daily"
        ? t("dest.dailyNote")
        : noteTitleFromPath(taskCreation?.inboxPath ?? "_Inbox.md");
  return (
    <div className="flex items-center gap-2 border-b border-border px-4 py-2">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder={t("addPlaceholder")}
        className="min-w-0 flex-1 rounded-md bg-surface px-3 py-1.5 text-sm text-fg outline-none ring-1 ring-border placeholder:text-fg-faint focus:ring-accent/50"
      />
      <div className="flex shrink-0 items-center rounded-md ring-1 ring-border">
        <button
          onClick={() => setPicking(true)}
          title={t("dest.pickTitle")}
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <FolderInput size={13} />
          <span className="max-w-[10rem] truncate">{t("dest.toLabel", { note: destName })}</span>
        </button>
        {pinnedNotePath && (
          <button
            onClick={() => setPinnedNotePath(null)}
            title={t("dest.clear")}
            className="rounded-md px-1.5 py-1.5 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={13} />
          </button>
        )}
      </div>
      <NotePickerModal
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(path) => {
          setPinnedNotePath(path);
          pushRecentDestination(path);
        }}
        title={t("dest.pickTitle")}
        recentPaths={recentDestinations}
      />
    </div>
  );
}

function FilterBar() {
  const { t } = useTranslation("tasks");
  const mode = useTasks((s) => s.mode);
  const tasks = useTasks((s) => s.tasks);
  const f = useTasks((s) => s.boardFilter);
  const setBoardFilter = useTasks((s) => s.setBoardFilter);
  const clearBoardFilter = useTasks((s) => s.clearBoardFilter);
  const groupBy = useTasks((s) => s.boardGroupBy);
  const setBoardGroupBy = useTasks((s) => s.setBoardGroupBy);
  const tags = useMemo(() => allTags(tasks), [tasks]);
  const folders = useMemo(() => topFolders(tasks), [tasks]);
  const projects = useMemo(() => allProjects(tasks), [tasks]);
  const active = boardFilterActive(f);
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
      <div className="flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 ring-1 ring-border">
        <Search size={12} className="text-fg-subtle" />
        <input
          value={f.text}
          onChange={(e) => setBoardFilter({ text: e.target.value })}
          placeholder={t("filterBar.search")}
          className="w-40 bg-transparent text-xs text-fg outline-none placeholder:text-fg-faint"
        />
      </div>
      <select
        value={f.priority ?? ""}
        onChange={(e) => setBoardFilter({ priority: e.target.value || null })}
        className={selectCls}
      >
        <option value="">{t("filterBar.anyPriority")}</option>
        <option value="urgent">{t("priority.urgent")}</option>
        <option value="high">{t("priority.high")}</option>
        <option value="medium">{t("priority.medium")}</option>
        <option value="low">{t("priority.low")}</option>
      </select>
      <select
        value={f.due}
        onChange={(e) => setBoardFilter({ due: e.target.value as DueBucket })}
        className={selectCls}
      >
        <option value="any">{t("filterBar.anyDue")}</option>
        <option value="overdue">{t("agenda.overdue")}</option>
        <option value="today">{t("agenda.today")}</option>
        <option value="week">{t("filterBar.thisWeek")}</option>
        <option value="none">{t("filterBar.noDue")}</option>
      </select>
      {tags.length > 0 && (
        <select
          value={f.tag ?? ""}
          onChange={(e) => setBoardFilter({ tag: e.target.value || null })}
          className={selectCls}
        >
          <option value="">{t("filterBar.anyTag")}</option>
          {tags.map((tag) => (
            <option key={tag} value={tag}>{`#${tag}`}</option>
          ))}
        </select>
      )}
      {folders.length > 0 && (
        <select
          value={f.folder ?? ""}
          onChange={(e) => setBoardFilter({ folder: e.target.value || null })}
          className={selectCls}
        >
          <option value="">{t("filterBar.anyFolder")}</option>
          {folders.map((folder) => (
            <option key={folder} value={folder}>
              {folder}
            </option>
          ))}
        </select>
      )}
      {projects.length > 0 && (
        <select
          value={f.project ?? ""}
          onChange={(e) => setBoardFilter({ project: e.target.value || null })}
          className={selectCls}
        >
          <option value="">{t("filterBar.anyProject")}</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      )}
      {active && (
        <button onClick={clearBoardFilter} className="text-xs text-fg-subtle hover:text-fg">
          {t("filterBar.clear")}
        </button>
      )}
      {mode === "kanban" && (
        <select
          value={groupBy}
          onChange={(e) => setBoardGroupBy(e.target.value as BoardGroupBy)}
          className={`${selectCls} ml-auto`}
        >
          <option value="none">{t("filterBar.groupNone")}</option>
          <option value="note">{t("filterBar.groupNote")}</option>
          <option value="folder">{t("filterBar.groupFolder")}</option>
          <option value="project">{t("filterBar.groupProject")}</option>
        </select>
      )}
    </div>
  );
}

/** Direct-children completion rollup per parent task id, in one pass over the
 *  full task list. Replaces the per-row `subtaskProgress(tasks, id)` scan
 *  (O(rows × tasks)); the parent views memoize one map per tasks array and
 *  pass each row/card its own narrow entry. */
function progressByParent(tasks: Task[]): Map<string, SubtaskCount> {
  const map = new Map<string, SubtaskCount>();
  for (const t of tasks) {
    if (!t.parentId) continue;
    let entry = map.get(t.parentId);
    if (!entry) {
      entry = { done: 0, total: 0 };
      map.set(t.parentId, entry);
    }
    entry.total += 1;
    if (t.completed) entry.done += 1;
  }
  return map;
}

interface SubtaskCount {
  done: number;
  total: number;
}

const TaskRow = memo(function TaskRow({
  task,
  progress,
}: {
  task: Task;
  /** This task's subtask rollup, if it has any subtasks. */
  progress?: SubtaskCount;
}) {
  const toggle = useTasks((s) => s.toggle);
  const openNoteFrom = useUi((s) => s.openNoteFrom);
  const openCardMenu = useTasks((s) => s.openCardMenu);
  return (
    <div
      className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-hover"
      onContextMenu={(e) => {
        e.preventDefault();
        openCardMenu(task.id, e.clientX, e.clientY);
      }}
    >
      <input
        type="checkbox"
        checked={task.completed}
        onChange={() => void toggle(task.id)}
        className="mt-1 accent-[var(--accent)]"
      />
      <div
        className="min-w-0 flex-1 cursor-pointer"
        onClick={() => openNoteFrom(task.sourceNote, "tasks")}
      >
        <div className={`text-sm ${task.completed ? "text-fg-faint line-through" : "text-fg"}`}>
          {displayText(task.text)}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
          {task.priority && <PriorityBadge priority={task.priority} />}
          {task.dueDate && <DueBadge due={task.dueDate} completed={task.completed} />}
          {progress && progress.total > 0 && (
            <SubtaskBadge done={progress.done} total={progress.total} />
          )}
          {task.tags.map((tag) => (
            <TagChip key={tag} tag={tag} />
          ))}
          <button
            onClick={(e) => {
              e.stopPropagation();
              openNoteFrom(task.sourceNote, "tasks");
            }}
            className="truncate hover:text-fg-muted"
            title={task.sourceNote}
          >
            {task.sourceNote}
          </button>
        </div>
      </div>
    </div>
  );
});

/** The single non-Kanban mode: a task list grouped into due-date sections
 *  (Overdue / Today / Upcoming / No date), with a trailing Completed section.
 *  Honors the open/all/completed filter, so completed tasks appear only when the
 *  filter loads them (then collected under "Completed" rather than scattered
 *  through the date buckets). */
/** The list flattened for virtualization: a group header followed by its task
 *  rows, so a single virtualizer drives the whole (grouped) list and only the
 *  on-screen rows mount. `first` suppresses the leading group gap. */
type ListRow =
  | { type: "header"; key: string; label: string; first: boolean }
  | { type: "task"; key: string; task: Task; progress?: SubtaskCount };

function ListView() {
  const { t } = useTranslation("tasks");
  const tasks = useTasks((s) => s.tasks);
  const boardFilter = useTasks((s) => s.boardFilter);
  const scrollRef = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => filterTasks(tasks, boardFilter), [tasks, boardFilter]);
  const groups = useMemo(() => groupByDue(visible), [visible]);
  // From the FULL list: subtasks count toward their parent even when a filter
  // hides them (matches the old per-row subtaskProgress(s.tasks, …) behavior).
  const progress = useMemo(() => progressByParent(tasks), [tasks]);
  const labels: Record<DueGroupKey, string> = {
    overdue: t("agenda.overdue"),
    today: t("agenda.today"),
    upcoming: t("agenda.upcoming"),
    noDate: t("agenda.noDate"),
    completed: t("agenda.completed"),
  };
  const flat: ListRow[] = [];
  for (const g of groups) {
    if (g.tasks.length === 0) continue;
    flat.push({ type: "header", key: `h:${g.key}`, label: labels[g.key], first: flat.length === 0 });
    for (const task of g.tasks) {
      flat.push({ type: "task", key: task.id, task, progress: progress.get(task.id) });
    }
  }
  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 44,
    overscan: 10,
    // Reproduce the container's p-3 (vertical) inside the virtual coordinate
    // space, so item positions don't drift from the scroll offset.
    paddingStart: 12,
    paddingEnd: 12,
    getItemKey: (i) => flat[i].key,
  });
  if (visible.length === 0) return <Empty />;
  return (
    <div ref={scrollRef} className="h-full overflow-y-auto px-3">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = flat[vi.index];
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {row.type === "header" ? (
                <h3
                  className={`px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle ${
                    row.first ? "" : "pt-5"
                  }`}
                >
                  {row.label}
                </h3>
              ) : (
                <TaskRow task={row.task} progress={row.progress} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const KanbanCard = memo(function KanbanCard({
  task,
  showNoteTitle,
  progress,
}: {
  task: Task;
  showNoteTitle?: boolean;
  /** This task's subtask rollup, if it has any subtasks. */
  progress?: SubtaskCount;
}) {
  const openNoteFrom = useUi((s) => s.openNoteFrom);
  const openCardMenu = useTasks((s) => s.openCardMenu);
  const folderColors = useVault((s) => s.folderColors);
  const projectColors = useSettings((s) => s.prefs?.taskView?.projectColors);
  // Stripe precedence: project color → top-folder color → first tag's color.
  const colorToken =
    (task.project ? projectColors?.[task.project] : undefined) ??
    folderColors[topFolderFromPath(task.sourceNote)];
  const stripe = colorToken
    ? COLOR_HEX[colorToken]
    : task.tags[0]
      ? tagColor(task.tags[0])
      : undefined;
  // Provenance: note title (unless the lane already is the note) › section heading.
  const noteTitle = task.noteTitle || noteTitleFromPath(task.sourceNote);
  const context = [showNoteTitle ? noteTitle : null, task.heading].filter(Boolean).join(" › ");
  const hasMeta =
    !!task.priority || !!task.dueDate || (progress?.total ?? 0) > 0 || task.tags.length > 0;
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", task.id)}
      onClick={() => openNoteFrom(task.sourceNote, "tasks")}
      onContextMenu={(e) => {
        e.preventDefault();
        openCardMenu(task.id, e.clientX, e.clientY);
      }}
      title={task.sourceNote}
      className="cursor-pointer rounded-md border border-border bg-surface p-2 text-sm text-fg transition-colors hover:border-border-strong"
      style={stripe ? { borderLeftColor: stripe, borderLeftWidth: "3px" } : undefined}
    >
      {context && <div className="mb-0.5 truncate text-xs text-fg-subtle">{context}</div>}
      <div>{displayText(task.text)}</div>
      {hasMeta && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {task.priority && <PriorityBadge priority={task.priority} />}
          {task.dueDate && <DueBadge due={task.dueDate} completed={task.completed} />}
          {progress && progress.total > 0 && (
            <SubtaskBadge done={progress.done} total={progress.total} />
          )}
          {task.tags.map((tag) => (
            <TagChip key={tag} tag={tag} />
          ))}
        </div>
      )}
    </div>
  );
});

function AddCard({ columnId, notePathOverride }: { columnId: string; notePathOverride?: string }) {
  const { t } = useTranslation("tasks");
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const addTask = useTasks((s) => s.addTask);
  const pinnedNotePath = useTasks((s) => s.pinnedNotePath);
  const activePath = useVault((s) => s.activePath);
  const taskCreation = useSettings((s) => s.prefs?.taskView?.taskCreation);
  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setAdding(false);
      return;
    }
    // In a per-note swimlane, add straight to that note; otherwise honor the
    // session pin, then the creation strategy (active note / inbox).
    const notePath =
      notePathOverride ??
      pinnedNotePath ??
      (taskCreation?.strategy === "active-note" && activePath ? activePath : undefined);
    void addTask(trimmed, { notePath, status: columnId });
    setText(""); // keep the input open for rapid entry
  };
  if (!adding) {
    return (
      <button
        onClick={() => setAdding(true)}
        className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
      >
        <Plus size={13} />
        {t("addCard")}
      </button>
    );
  }
  return (
    <textarea
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          setText("");
          setAdding(false);
        }
      }}
      onBlur={() => {
        if (!text.trim()) setAdding(false);
      }}
      placeholder={t("addCardPlaceholder")}
      rows={2}
      className="w-full resize-none rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-accent/50"
    />
  );
}

/** A single flat-board column's card list, virtualized: only the on-screen
 *  cards mount (initial mount is O(viewport), not O(cards)). The scroll element
 *  is this column's own `overflow-y-auto` div — drag-and-drop still fires on the
 *  cards (each `KanbanCard` is `draggable`) and bubbles its drop to the column,
 *  and the `AddCard` stays pinned at the bottom below the virtual list. */
function VirtualCardList({
  tasks,
  showNoteTitle,
  progress,
  columnId,
  addToNotePath,
}: {
  tasks: Task[];
  showNoteTitle: boolean;
  progress: Map<string, SubtaskCount>;
  columnId: string;
  addToNotePath?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
    gap: 8, // matches the old space-y-2 between cards
    getItemKey: (i) => tasks[i].id,
  });
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto p-2">
      {tasks.length > 0 && (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const task = tasks[vi.index];
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <KanbanCard task={task} showNoteTitle={showNoteTitle} progress={progress.get(task.id)} />
              </div>
            );
          })}
        </div>
      )}
      <div className={tasks.length > 0 ? "mt-2" : ""}>
        <AddCard columnId={columnId} notePathOverride={addToNotePath} />
      </div>
    </div>
  );
}

/** The 5 status columns rendered for a set of tasks. Reused by the flat board
 *  (`fill` = full height, own scroll) and by each swimlane band (`fill` = false,
 *  sizes to content; the band itself scrolls). */
function BoardColumns({
  tasks,
  fill,
  showNoteTitle,
  addToNotePath,
  progress,
}: {
  tasks: Task[];
  fill: boolean;
  showNoteTitle: boolean;
  addToNotePath?: string;
  /** Subtask rollups per parent task id (memoized by the view). */
  progress: Map<string, SubtaskCount>;
}) {
  const { t } = useTranslation("tasks");
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
    <div className={`flex gap-3 overflow-x-auto ${fill ? "h-full p-3" : ""}`}>
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
          {fill ? (
            // Flat board: this column owns its scroll, so virtualize its cards.
            <VirtualCardList
              tasks={tasks.filter((task) => !task.completed && columnFor(task) === col.id)}
              showNoteTitle={showNoteTitle}
              progress={progress}
              columnId={col.id}
              addToNotePath={addToNotePath}
            />
          ) : (
            // Swimlane band: no per-column scroll (the band scrolls) and the
            // group is already small — render the cards directly.
            <div className="space-y-2 p-2">
              {tasks
                .filter((task) => !task.completed && columnFor(task) === col.id)
                .map((task) => (
                  <KanbanCard
                    key={task.id}
                    task={task}
                    showNoteTitle={showNoteTitle}
                    progress={progress.get(task.id)}
                  />
                ))}
              <AddCard columnId={col.id} notePathOverride={addToNotePath} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** A collapsible swimlane band: a titled, optionally color-striped header with a
 *  card count, wrapping a `BoardColumns` for that group's tasks. */
function Swimlane({
  title,
  color,
  count,
  children,
}: {
  title: string;
  color?: string;
  count: number;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div className="rounded-lg border border-border">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Chevron size={14} className="shrink-0 text-fg-subtle" />
        {color && (
          <span className="h-3.5 w-1 shrink-0 rounded-full" style={{ background: color }} />
        )}
        <span className="truncate text-sm font-medium text-fg">{title}</span>
        <span className="ml-0.5 rounded-full bg-surface-2 px-1.5 text-xs text-fg-subtle">
          {count}
        </span>
      </button>
      {!collapsed && <div className="px-2 pb-2">{children}</div>}
    </div>
  );
}

interface TaskGroup {
  key: string;
  folder: string;
  project: string;
  notePath: string | null;
  noteTitle: string;
  tasks: Task[];
}

/** Bucket open tasks by source note, top-level folder, or @project, sorted by
 *  key. Each group also carries the representative note title + folder/project
 *  for the lane header. */
function groupTasks(tasks: Task[], by: "note" | "folder" | "project"): TaskGroup[] {
  const map = new Map<string, TaskGroup>();
  for (const task of tasks) {
    const folder = topFolderFromPath(task.sourceNote);
    const project = task.project ?? "";
    const key = by === "note" ? task.sourceNote : by === "folder" ? folder : project;
    let entry = map.get(key);
    if (!entry) {
      entry = {
        key,
        folder,
        project,
        notePath: by === "note" ? task.sourceNote : null,
        noteTitle: task.noteTitle || noteTitleFromPath(task.sourceNote),
        tasks: [],
      };
      map.set(key, entry);
    }
    entry.tasks.push(task);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function KanbanView() {
  const { t } = useTranslation("tasks");
  const tasks = useTasks((s) => s.tasks);
  const boardFilter = useTasks((s) => s.boardFilter);
  const groupBy = useTasks((s) => s.boardGroupBy);
  const folderColors = useVault((s) => s.folderColors);
  const projectColors = useSettings((s) => s.prefs?.taskView?.projectColors);
  const visible = useMemo(() => filterTasks(tasks, boardFilter), [tasks, boardFilter]);
  // From the FULL list: subtasks count toward their parent even when a filter
  // hides them (matches the old per-card subtaskProgress(s.tasks, …) behavior).
  const progress = useMemo(() => progressByParent(tasks), [tasks]);

  if (groupBy === "none") {
    return <BoardColumns tasks={visible} fill showNoteTitle progress={progress} />;
  }

  const open = visible.filter((task) => !task.completed);
  const groups = groupTasks(open, groupBy);
  if (groups.length === 0) return <Empty />;
  return (
    <div className="h-full space-y-3 overflow-y-auto p-3">
      {groups.map((g) => {
        const token =
          groupBy === "project"
            ? g.project
              ? projectColors?.[g.project]
              : undefined
            : folderColors[g.folder];
        const color = token ? COLOR_HEX[token] : undefined;
        const title =
          groupBy === "note"
            ? g.noteTitle
            : groupBy === "project"
              ? g.project || t("kanban.noProject")
              : g.folder || t("kanban.rootFolder");
        return (
          <Swimlane key={g.key} title={title} color={color} count={g.tasks.length}>
            <BoardColumns
              tasks={g.tasks}
              fill={false}
              showNoteTitle={groupBy !== "note"}
              addToNotePath={groupBy === "note" ? (g.notePath ?? undefined) : undefined}
              progress={progress}
            />
          </Swimlane>
        );
      })}
    </div>
  );
}

type DueGroupKey = "overdue" | "today" | "upcoming" | "noDate" | "completed";

/** Bucket tasks by due date for the list view. Completed tasks are collected in
 *  their own trailing section rather than scattered through the date buckets. */
function groupByDue(tasks: Task[]): { key: DueGroupKey; tasks: Task[] }[] {
  const today = new Date().toISOString().slice(0, 10);
  const groups: Record<DueGroupKey, Task[]> = {
    overdue: [],
    today: [],
    upcoming: [],
    noDate: [],
    completed: [],
  };
  for (const task of tasks) {
    if (task.completed) groups.completed.push(task);
    else if (!task.dueDate) groups.noDate.push(task);
    else if (task.dueDate < today) groups.overdue.push(task);
    else if (task.dueDate === today) groups.today.push(task);
    else groups.upcoming.push(task);
  }
  return (["overdue", "today", "upcoming", "noDate", "completed"] as DueGroupKey[]).map((key) => ({
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
