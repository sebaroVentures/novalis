import { useEffect, useMemo, useRef, useState } from "react";

import { ArrowUpRight, Bookmark, ChevronLeft, ChevronRight, Play, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useHelpLoaded } from "../help/loadHelp";
import { QUERY_SYNTAX } from "../help/querySyntax";
import type { PropertyValue, QueryResult, QueryViewKind, SavedQuery, Task } from "../ipc/api";
import { api, NovalisError } from "../ipc/api";
import { displayText, noteTitleFromPath } from "../lib/taskDisplay";
import { useSettings } from "../stores/settingsStore";
import { useUi } from "../stores/uiStore";
import { DueBadge, PriorityBadge, TagChip } from "./TaskBadges";
import { Modal } from "./ui/Modal";

/** The kanban columns query results are bucketed into (a task's `@status`, with
 *  a catch-all "" column for un-statused tasks). Deliberately static: the query
 *  view is a read-only lens, not the editable task board. */
const KANBAN_COLUMN_IDS = ["", "todo", "in-progress", "review", "done"] as const;

/** Render a typed frontmatter property value as a compact cell string. */
function propText(value: PropertyValue | undefined): string {
  if (!value) return "";
  switch (value.kind) {
    case "text":
      return value.value;
    case "number":
      return value.value === null ? "" : String(value.value);
    case "checkbox":
      return value.value ? "✓" : "✗";
    case "list":
      return value.value.join(", ");
  }
}

/** Enter/Space activate a `role="button"` element — keyboard parity for the
 *  result rows/cards that are plain `onClick` elements (not real buttons). */
function onActivateKey(fn: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

export function QueryView() {
  const { t } = useTranslation("common");
  const [input, setInput] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [view, setView] = useState<QueryViewKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [naming, setNaming] = useState(false);
  const saved = useSettings((s) => s.prefs?.savedQueries ?? []);
  const setSavedQueries = useSettings((s) => s.setSavedQueries);

  const run = async (q: string) => {
    const query = q.trim();
    setRunning(true);
    setError(null);
    try {
      const r = await api.runQuery(query);
      setResult(r);
      setView(null); // adopt the query's suggested view
    } catch (e) {
      setResult(null);
      setError(e instanceof NovalisError ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const saveCurrent = () => {
    if (!input.trim()) return;
    setNaming(true);
  };

  const commitName = (rawName: string) => {
    const query = input.trim();
    const name = rawName.trim();
    if (!query || !name) return;
    const next: SavedQuery[] = [...saved.filter((s) => s.name !== name), { name, query }];
    next.sort((a, b) => a.name.localeCompare(b.name));
    setSavedQueries(next);
    setNaming(false);
  };

  const loadSaved = (q: SavedQuery) => {
    setInput(q.query);
    void run(q.query);
  };

  const deleteSaved = (name: string) => setSavedQueries(saved.filter((s) => s.name !== name));

  const effectiveView: QueryViewKind = view ?? result?.view ?? "table";
  const hasTasks = (result?.tasks.length ?? 0) > 0;
  const hasDates = result?.hasDates ?? false;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex flex-col gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run(input);
            }}
            spellCheck={false}
            placeholder={t("query.placeholder")}
            className="min-w-0 flex-1 rounded-md bg-surface px-3 py-1.5 font-mono text-sm text-fg outline-none ring-1 ring-border placeholder:text-fg-faint focus:ring-accent/50"
          />
          <button
            onClick={() => void run(input)}
            disabled={running}
            className="flex shrink-0 items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Play size={13} />
            {t("query.run")}
          </button>
          <button
            onClick={saveCurrent}
            title={t("query.save")}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-sm text-fg-muted ring-1 ring-border transition-colors hover:bg-hover hover:text-fg"
          >
            <Bookmark size={13} />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-fg-faint">{t("query.hint")}</span>
        </div>
        {saved.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {saved.map((q) => (
              <span
                key={q.name}
                className="group flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-fg-muted ring-1 ring-border"
              >
                <button onClick={() => loadSaved(q)} className="hover:text-fg" title={q.query}>
                  {q.name}
                </button>
                <button
                  onClick={() => deleteSaved(q.name)}
                  title={t("query.deleteSaved")}
                  className="text-fg-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
      </header>

      {result && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-1.5">
          <ViewTab active={effectiveView === "table"} onClick={() => setView("table")}>
            {t("query.view.table")}
          </ViewTab>
          <ViewTab
            active={effectiveView === "kanban"}
            disabled={!hasTasks}
            onClick={() => setView("kanban")}
          >
            {t("query.view.kanban")}
          </ViewTab>
          <ViewTab
            active={effectiveView === "calendar"}
            disabled={!hasDates}
            onClick={() => setView("calendar")}
          >
            {t("query.view.calendar")}
          </ViewTab>
          <span className="ml-auto text-xs text-fg-subtle">
            {t("query.results", { n: result.notes.length })}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-sm text-danger">{error}</div>
        ) : !result ? (
          <QueryEmptyState />
        ) : effectiveView === "kanban" ? (
          <KanbanResult tasks={result.tasks} />
        ) : effectiveView === "calendar" ? (
          <CalendarResult result={result} />
        ) : (
          <TableResult result={result} />
        )}
      </div>

      {naming && <SaveQueryModal onSubmit={commitName} onCancel={() => setNaming(false)} />}
    </section>
  );
}

/** Pre-first-run empty state: the prompt hint, a Feature Guide link, and — once
 *  the lazy help catalogs are in — the query DSL syntax table, the same rows
 *  the guide's queryEngine topic renders (no spinner: the table just appends
 *  when ready). useHelpLoaded kicks off ensureHelpLoaded on mount, so the
 *  catalogs load only when this empty state actually renders. The rows come
 *  from help/querySyntax.ts rather than the registry so this eagerly-imported
 *  view doesn't drag the whole guide registry into the main bundle; the
 *  dynamic `help:` desc keys are kept alive by the enumeration in
 *  help/registry.ts. */
function QueryEmptyState() {
  const { t, i18n } = useTranslation(["common", "help"]);
  const helpLoaded = useHelpLoaded();
  const syntax = QUERY_SYNTAX;
  // descKey is a runtime string (registry data), so the lookup needs an escape
  // hatch from the typed key union; help/registry.ts enumerates the keys for
  // i18next-parser and its test proves they exist.
  const helpText = (key: string): string => (i18n.t as unknown as (k: string) => string)(key);
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 p-4">
      <p className="text-sm text-fg-faint">{t("query.prompt")}</p>
      <button
        type="button"
        onClick={() => useUi.getState().openHelp("queryEngine")}
        className="flex items-center gap-1 text-xs text-fg-subtle transition-colors hover:text-fg"
      >
        {t("helpGuide")}
        <ArrowUpRight size={12} />
      </button>
      {helpLoaded && syntax.length > 0 && (
        <table className="mt-2 text-xs">
          <tbody>
            {syntax.map((row) => (
              <tr key={row.code}>
                <td className="whitespace-nowrap py-0.5 pr-4 font-mono text-fg-muted">
                  {row.code}
                </td>
                <td className="py-0.5 text-fg-subtle">{helpText(`help:${row.descKey}`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** In-app "name this query" prompt. Replaces `window.prompt`, which returns null
 *  immediately in the Tauri macOS WKWebView, silently no-op-ing Save. Reuses the
 *  Modal shell (focus trap + Escape) with a text input; Enter submits. */
function SaveQueryModal({
  onSubmit,
  onCancel,
}: {
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("common");
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = () => {
    if (name.trim()) onSubmit(name);
  };
  return (
    <Modal
      label={t("query.namePrompt")}
      onClose={onCancel}
      initialFocusRef={inputRef}
      overlayClassName="z-[60] items-center justify-center p-6"
      panelClassName="w-full max-w-sm overflow-hidden rounded-xl border border-border-strong bg-surface p-5 shadow-2xl"
    >
      <h3 className="text-sm font-semibold text-fg">{t("query.namePrompt")}</h3>
      <input
        ref={inputRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t("query.namePlaceholder")}
        className="mt-3 w-full rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-fg outline-none ring-1 ring-transparent transition placeholder:text-fg-faint focus:ring-accent/50"
      />
      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          {t("cancel")}
        </button>
        <button
          onClick={submit}
          disabled={!name.trim()}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("query.save")}
        </button>
      </div>
    </Modal>
  );
}

function ViewTab({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
        active ? "bg-active text-fg" : "text-fg-muted hover:text-fg"
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

function TableResult({ result }: { result: QueryResult }) {
  const { t } = useTranslation("common");
  const openNoteFrom = useUi((s) => s.openNoteFrom);
  if (result.notes.length === 0) {
    return <Empty>{t("query.empty")}</Empty>;
  }
  return (
    <table className="w-full border-collapse text-sm">
      <thead className="sticky top-0 bg-surface text-left text-xs text-fg-subtle">
        <tr className="border-b border-border">
          <th className="px-4 py-2 font-medium">{t("query.columns.title")}</th>
          <th className="px-4 py-2 font-medium">{t("query.columns.folder")}</th>
          {result.propertyKeys.map((k) => (
            <th key={k} className="px-4 py-2 font-medium">
              {k}
            </th>
          ))}
          <th className="px-4 py-2 font-medium">{t("query.columns.modified")}</th>
        </tr>
      </thead>
      <tbody>
        {result.notes.map((n) => {
          const byKey = new Map(n.properties.map((p) => [p.key, p.value]));
          return (
            <tr
              key={n.path}
              role="button"
              tabIndex={0}
              onClick={() => openNoteFrom(n.path, "query")}
              onKeyDown={onActivateKey(() => openNoteFrom(n.path, "query"))}
              className="cursor-pointer border-b border-border/60 hover:bg-hover focus:bg-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
            >
              <td className="max-w-xs truncate px-4 py-1.5 text-fg" title={n.path}>
                {n.title}
                {n.tags.length > 0 && (
                  <span className="ml-2 inline-flex gap-1 align-middle">
                    {n.tags.slice(0, 3).map((tag) => (
                      <TagChip key={tag} tag={tag} />
                    ))}
                  </span>
                )}
              </td>
              <td className="max-w-[10rem] truncate px-4 py-1.5 text-fg-subtle">{n.folder}</td>
              {result.propertyKeys.map((k) => (
                <td key={k} className="max-w-[12rem] truncate px-4 py-1.5 text-fg-muted">
                  {propText(byKey.get(k))}
                </td>
              ))}
              <td className="whitespace-nowrap px-4 py-1.5 text-xs text-fg-faint">
                {n.modified.slice(0, 10)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function KanbanResult({ tasks }: { tasks: Task[] }) {
  const { t } = useTranslation("common");
  const openNoteFrom = useUi((s) => s.openNoteFrom);
  const colLabels: Record<string, string> = {
    "": t("query.kanban.none"),
    todo: t("query.kanban.todo"),
    "in-progress": t("query.kanban.inProgress"),
    review: t("query.kanban.review"),
    done: t("query.kanban.done"),
  };
  const columnFor = (task: Task) =>
    task.status && (KANBAN_COLUMN_IDS as readonly string[]).includes(task.status)
      ? task.status
      : "";
  if (tasks.length === 0) return <Empty>{t("query.noTasks")}</Empty>;
  return (
    <div className="flex h-full gap-3 overflow-x-auto p-3">
      {KANBAN_COLUMN_IDS.map((colId) => {
        const colTasks = tasks.filter((task) => columnFor(task) === colId);
        return (
          <div key={colId} className="flex w-64 shrink-0 flex-col rounded-lg bg-surface/50">
            <div className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
              {colLabels[colId]} <span className="text-fg-faint">{colTasks.length}</span>
            </div>
            <div className="flex flex-col gap-2 overflow-y-auto p-2">
              {colTasks.map((task) => (
                <div
                  key={task.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openNoteFrom(task.sourceNote, "query")}
                  onKeyDown={onActivateKey(() => openNoteFrom(task.sourceNote, "query"))}
                  title={task.sourceNote}
                  className="cursor-pointer rounded-md border border-border bg-surface p-2 text-sm text-fg transition-colors hover:border-border-strong focus:outline-none focus-visible:border-accent/60 focus-visible:ring-1 focus-visible:ring-accent/60"
                >
                  <div className="mb-0.5 truncate text-xs text-fg-subtle">
                    {task.noteTitle || noteTitleFromPath(task.sourceNote)}
                  </div>
                  <div className={task.completed ? "text-fg-faint line-through" : undefined}>
                    {displayText(task.text)}
                  </div>
                  {(task.priority || task.dueDate || task.tags.length > 0) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {task.priority && <PriorityBadge priority={task.priority} />}
                      {task.dueDate && <DueBadge due={task.dueDate} completed={task.completed} />}
                      {task.tags.map((tag) => (
                        <TagChip key={tag} tag={tag} />
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A local YYYY-MM-DD for a Date (avoids the UTC shift of toISOString). */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function CalendarResult({ result }: { result: QueryResult }) {
  const { t } = useTranslation("common");
  const openNoteFrom = useUi((s) => s.openNoteFrom);
  const dated = useMemo(
    () => result.notes.filter((n) => n.date && n.date.length >= 10),
    [result.notes],
  );
  // Anchor the grid on the first dated note's month (fall back to today).
  const [anchor, setAnchor] = useState(() => {
    const first = dated.find((n) => n.date);
    const base = first?.date ? new Date(`${first.date.slice(0, 10)}T00:00:00`) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const byDay = useMemo(() => {
    const map = new Map<string, typeof dated>();
    for (const n of dated) {
      const key = n.date!.slice(0, 10);
      const arr = map.get(key) ?? [];
      arr.push(n);
      map.set(key, arr);
    }
    return map;
  }, [dated]);

  // Re-anchor on the first dated note whenever a new query changes the set (but
  // not while the user pages months — `dated` is stable across that).
  useEffect(() => {
    const first = dated.find((n) => n.date);
    const base = first?.date ? new Date(`${first.date.slice(0, 10)}T00:00:00`) : new Date();
    setAnchor(new Date(base.getFullYear(), base.getMonth(), 1));
  }, [dated]);

  if (dated.length === 0) return <Empty>{t("query.noDates")}</Empty>;

  // Six-week grid starting on the Monday on/before the 1st.
  const first = new Date(anchor);
  const offset = (first.getDay() + 6) % 7; // Monday=0
  const start = new Date(first);
  start.setDate(first.getDate() - offset);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  const monthLabel = anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="flex h-full flex-col p-3">
      <div className="mb-2 flex items-center gap-2">
        <button
          onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1))}
          className="rounded px-2 py-1 text-fg-muted hover:bg-hover"
          aria-label={t("query.prevMonth")}
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-sm font-medium text-fg">{monthLabel}</span>
        <button
          onClick={() => setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1))}
          className="rounded px-2 py-1 text-fg-muted hover:bg-hover"
          aria-label={t("query.nextMonth")}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 gap-px overflow-y-auto rounded-md bg-border">
        {days.map((d) => {
          const key = isoDay(d);
          const inMonth = d.getMonth() === anchor.getMonth();
          const notes = byDay.get(key) ?? [];
          return (
            <div
              key={key}
              className={`min-h-[4rem] p-1 ${inMonth ? "bg-surface" : "bg-surface-2/40"}`}
            >
              <div className={`text-xs ${inMonth ? "text-fg-subtle" : "text-fg-faint"}`}>
                {d.getDate()}
              </div>
              <div className="mt-0.5 flex flex-col gap-0.5">
                {notes.map((n) => (
                  <button
                    key={n.path}
                    onClick={() => openNoteFrom(n.path, "query")}
                    title={n.path}
                    className="truncate rounded bg-accent/15 px-1 py-0.5 text-left text-xs text-accent hover:bg-accent/25"
                  >
                    {n.title}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-fg-faint">{children}</div>
  );
}
