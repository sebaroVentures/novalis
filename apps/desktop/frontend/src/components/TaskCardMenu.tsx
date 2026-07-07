import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ArrowUpRight, FolderInput } from "lucide-react";
import { useTranslation } from "react-i18next";

import { displayText, noteTitleFromPath } from "../lib/taskDisplay";
import { useDismiss } from "../lib/useDismiss";
import { allEpics, allProjects, useTasks } from "../stores/taskStore";
import { useUi } from "../stores/uiStore";
import { NotePickerModal } from "./NotePickerModal";
import { SlugField } from "./SlugField";
import { TagChip } from "./TaskBadges";

const selectCls =
  "w-full rounded-md bg-surface-2 px-2 py-1 text-sm text-fg outline-none ring-1 ring-border focus:ring-accent/50";

/** The controls the menu's Arrow/Home/End cycling walks through. */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Cursor-positioned popover opened by right-clicking a task card/row — the full
 *  task surface (status, project+color, epic, priority, due, tags, subtasks,
 *  open note, delete). Clamps to the viewport and dismisses on outside
 *  mousedown / Escape / resize (same pattern as ContextMenu, which can't be
 *  reused because it only renders button items). */
export function TaskCardMenu() {
  const { t } = useTranslation("tasks");
  const menu = useTasks((s) => s.cardMenu);
  const close = useTasks((s) => s.closeCardMenu);
  const tasks = useTasks((s) => s.tasks);
  const columns = useTasks((s) => s.columns);
  const toggle = useTasks((s) => s.toggle);
  const setStatus = useTasks((s) => s.setStatus);
  const updateField = useTasks((s) => s.updateField);
  const deleteTask = useTasks((s) => s.deleteTask);
  const moveTask = useTasks((s) => s.moveTask);
  const recentDestinations = useTasks((s) => s.recentDestinations);
  const pushRecentDestination = useTasks((s) => s.pushRecentDestination);
  const openNoteFrom = useUi((s) => s.openNoteFrom);

  const task = useMemo(
    () => (menu ? (tasks.find((x) => x.id === menu.taskId) ?? null) : null),
    [tasks, menu],
  );
  const subtasks = useMemo(
    () => (task ? tasks.filter((x) => x.parentId === task.id) : []),
    [tasks, task],
  );
  const projects = useMemo(() => allProjects(tasks), [tasks]);
  const epics = useMemo(() => allEpics(tasks), [tasks]);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    setConfirmDelete(false);
    setMoving(false);
  }, [menu?.taskId]);

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - width - 8),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - height - 8)),
    });
  }, [menu]);

  useDismiss(ref, !!menu, close, { closeOnResize: true });

  // Focus management: on open, move focus to the menu's first control (the
  // completion checkbox); on close, hand it back to the invoker — unless the
  // close came from clicking a control elsewhere, which already moved focus.
  // `menu` is referentially stable while open, so this runs once per open.
  useEffect(() => {
    if (!menu) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    el?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      if (!prev || prev === document.body || !prev.isConnected) return;
      const active = document.activeElement;
      if (active === null || active === document.body || (el?.contains(active) ?? false)) {
        prev.focus();
      }
    };
  }, [menu]);

  // ArrowUp/Down cycle and Home/End jump across the menu's controls. Fields
  // that use these keys themselves (selects, text/date/time inputs — anything
  // but checkboxes) and the nested note-picker dialog keep native handling.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const target = e.target as HTMLElement;
    if (target.closest('[role="dialog"]')) return;
    const tag = target.tagName;
    if (tag === "SELECT" || tag === "TEXTAREA") return;
    if (tag === "INPUT" && (target as HTMLInputElement).type !== "checkbox") return;
    e.preventDefault();
    e.stopPropagation();
    const els = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => !el.closest('[role="dialog"]'),
    );
    if (els.length === 0) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? els[0]
        : e.key === "End"
          ? els[els.length - 1]
          : e.key === "ArrowDown"
            ? els[(i + 1) % els.length]
            : els[i <= 0 ? els.length - 1 : i - 1];
    next.focus();
  };

  if (!menu || !task) return null;

  const colIds = columns.map((c) => c.id);
  const currentStatus =
    task.status && colIds.includes(task.status) ? task.status : (columns[0]?.id ?? "");
  const context = [task.noteTitle || noteTitleFromPath(task.sourceNote), task.heading]
    .filter(Boolean)
    .join(" › ");
  const doneSubs = subtasks.filter((s) => s.completed).length;

  const openNote = () => {
    openNoteFrom(task.sourceNote, "tasks");
    close();
  };

  const handleMove = (dest: string) => {
    pushRecentDestination(dest);
    void moveTask(task.id, dest); // moveTask reloads and closes the card menu
    setMoving(false);
  };

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 flex max-h-[85vh] w-72 flex-col overflow-y-auto rounded-lg border border-border-strong/80 bg-surface p-1.5 shadow-xl"
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      <div className="flex items-start gap-2 px-1 pb-1.5">
        <input
          type="checkbox"
          checked={task.completed}
          onChange={() => void toggle(task.id)}
          className="mt-0.5 accent-[var(--accent)]"
        />
        <div className="min-w-0 flex-1">
          <div
            className={`text-sm font-medium ${
              task.completed ? "text-fg-faint line-through" : "text-fg"
            }`}
          >
            {displayText(task.text)}
          </div>
          {context && <div className="mt-0.5 truncate text-xs text-fg-subtle">{context}</div>}
          {!task.completed && (
            <div className="mt-1 text-[11px] leading-snug text-fg-faint">
              {t("detail.completeHint")}
            </div>
          )}
        </div>
      </div>

      <button
        onClick={openNote}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-fg transition-colors hover:bg-hover"
      >
        <ArrowUpRight size={13} />
        {t("detail.openNote")}
      </button>

      <button
        onClick={() => setMoving(true)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs text-fg transition-colors hover:bg-hover"
      >
        <FolderInput size={13} />
        {t("menu.moveToNote")}
      </button>

      <div className="my-1 border-t border-border" />

      <div className="space-y-1.5">
        <Row label={t("detail.status")}>
          <select
            value={currentStatus}
            onChange={(e) => void setStatus(task.id, e.target.value)}
            className={selectCls}
          >
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </Row>

        <Row label={t("detail.project")}>
          <SlugField
            task={task}
            field="project"
            suggestions={projects}
            datalistId="nv-project-menu"
            placeholder={t("detail.noProject")}
            withColor
          />
        </Row>

        <Row label={t("detail.epic")}>
          <SlugField
            task={task}
            field="epic"
            suggestions={epics}
            datalistId="nv-epic-menu"
            placeholder={t("detail.noEpic")}
          />
        </Row>

        <Row label={t("detail.priority")}>
          <select
            value={task.priority ?? ""}
            onChange={(e) => void updateField(task.id, "priority", e.target.value || null)}
            className={selectCls}
          >
            <option value="">{t("detail.noPriority")}</option>
            <option value="urgent">{t("priority.urgent")}</option>
            <option value="high">{t("priority.high")}</option>
            <option value="medium">{t("priority.medium")}</option>
            <option value="low">{t("priority.low")}</option>
          </select>
        </Row>

        <Row label={t("detail.start")}>
          <input
            type="date"
            value={task.startDate ?? ""}
            onChange={(e) => void updateField(task.id, "start", e.target.value || null)}
            className={selectCls}
          />
        </Row>

        <Row label={t("detail.due")}>
          <input
            type="date"
            value={task.dueDate ?? ""}
            onChange={(e) => void updateField(task.id, "due", e.target.value || null)}
            className={selectCls}
          />
        </Row>

        <Row label={t("detail.repeat")}>
          <select
            value={task.repeat ?? ""}
            onChange={(e) => void updateField(task.id, "repeat", e.target.value || null)}
            className={selectCls}
          >
            <option value="">{t("detail.noRepeat")}</option>
            <option value="daily">{t("repeat.daily")}</option>
            <option value="weekly">{t("repeat.weekly")}</option>
            <option value="monthly">{t("repeat.monthly")}</option>
            <option value="yearly">{t("repeat.yearly")}</option>
          </select>
        </Row>

        <Row label={t("detail.remind")}>
          <input
            type="datetime-local"
            value={task.remind ?? ""}
            onChange={(e) => void updateField(task.id, "remind", e.target.value || null)}
            className={selectCls}
          />
        </Row>

        {task.tags.length > 0 && (
          <Row label={t("detail.tags")}>
            <div className="flex flex-wrap gap-1.5">
              {task.tags.map((tag) => (
                <TagChip key={tag} tag={tag} />
              ))}
            </div>
          </Row>
        )}
      </div>

      {subtasks.length > 0 && (
        <>
          <div className="my-1 border-t border-border" />
          <div className="px-1">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
              {t("detail.subtasks", { done: doneSubs, total: subtasks.length })}
            </div>
            <div className="space-y-1">
              {subtasks.map((s) => (
                <label key={s.id} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={s.completed}
                    onChange={() => void toggle(s.id)}
                    className="mt-1 accent-[var(--accent)]"
                  />
                  <span className={s.completed ? "text-fg-faint line-through" : "text-fg"}>
                    {displayText(s.text)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="my-1 border-t border-border" />

      {!confirmDelete ? (
        <button
          onClick={() => setConfirmDelete(true)}
          className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-danger transition-colors hover:bg-red-500/10"
        >
          {t("menu.delete")}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 px-2 py-1">
          <button
            onClick={() => void deleteTask(task.id)}
            className="rounded-md bg-red-500/15 px-2 py-1 text-xs text-danger transition-colors hover:bg-red-500/25"
          >
            {t("menu.confirmDelete")}
          </button>
          <button
            onClick={() => setConfirmDelete(false)}
            className="rounded-md px-2 py-1 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            {t("menu.cancel")}
          </button>
        </div>
      )}

      <NotePickerModal
        open={moving}
        onClose={() => setMoving(false)}
        onPick={handleMove}
        title={t("notePicker.moveTitle")}
        recentPaths={recentDestinations}
      />
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className="w-14 shrink-0 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
