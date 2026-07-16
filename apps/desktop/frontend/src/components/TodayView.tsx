import { useEffect, type ReactNode } from "react";

import { CalendarDays, ChevronLeft, ChevronRight, Mic } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, type AgendaItem } from "../ipc/api";
import { formatDayLong, formatTime } from "../lib/datetime";
import { displayText } from "../lib/taskDisplay";
import { addDays, isoDay, useAgenda } from "../stores/agendaStore";
import { useSettings } from "../stores/settingsStore";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";
import { useVoice } from "../stores/voiceStore";

/** Extract a `HH:MM` time from a `YYYY-MM-DDTHH:MM` agenda start, or null. */
function timeOf(start: string): string | null {
  const i = start.indexOf("T");
  return i === -1 ? null : start.slice(i + 1, i + 6);
}

/** Daily-planning hub: the focused day's calendar events + scheduled/due tasks,
 *  plus an Overdue section when viewing the actual today. Data comes from the
 *  backend get_agenda (tasks placed on their @start, else @due). */
export function TodayView() {
  const { t } = useTranslation(["today", "ai"]);
  const focus = useAgenda((s) => s.focus);
  const items = useAgenda((s) => s.items);
  const overdue = useAgenda((s) => s.overdue);
  const load = useAgenda((s) => s.load);
  const timeFormatPref = useSettings((s) => s.prefs?.calendar?.timeFormat);
  const timeFormat: "12h" | "24h" = timeFormatPref === "12h" ? "12h" : "24h";
  const openNoteFrom = useUi((s) => s.openNoteFrom);
  const voiceAvailable = useVoice((s) => s.available);
  const voiceStatus = useVoice((s) => s.status);

  useEffect(() => {
    void load(focus);
    // Load once on mount; navigation calls load() directly with a new focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const today = isoDay(new Date());
  const events = items.filter((i) => i.kind === "event");
  const tasks = items.filter((i) => i.kind === "task");
  const [fy, fm, fd] = focus.split("-").map(Number);
  const focusDate = new Date(fy, fm - 1, fd);

  const toggleTask = (id: string) => {
    void api
      .toggleTask(id)
      .catch(() => {})
      .finally(() => void load(focus));
  };
  const openSource = (notePath: string | null) => {
    if (notePath) openNoteFrom(notePath, "today");
  };
  const openTodaysNote = async () => {
    const path = `journal/${focus.slice(0, 4)}/${focus}.md`;
    try {
      await api.createNote(path, { content: "" });
    } catch {
      /* already exists — fall through and open it */
    }
    await useVault.getState().refreshTree();
    openNoteFrom(path, "today");
  };

  const empty = events.length === 0 && tasks.length === 0 && overdue.length === 0;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-5 py-2.5">
        <div className="flex items-center gap-2">
          <CalendarDays size={16} className="text-fg-muted" />
          <h2 className="text-sm font-medium text-fg">{formatDayLong(focusDate)}</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void load(addDays(focus, -1))}
            title={t("prevDay")}
            className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-active hover:text-fg"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            onClick={() => void load(today)}
            className="rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-active hover:text-fg"
          >
            {t("jumpToday")}
          </button>
          <button
            onClick={() => void load(addDays(focus, 1))}
            title={t("nextDay")}
            className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-active hover:text-fg"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          <div className="flex items-center gap-2 self-start">
            <button
              onClick={() => void openTodaysNote()}
              className="rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-active hover:text-fg"
            >
              {t("openTodaysNote")}
            </button>
            {voiceAvailable && (
              <button
                onClick={() => void useVoice.getState().start()}
                disabled={voiceStatus !== "idle"}
                title={t("ai:voice.tooltip")}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-active hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Mic size={13} />
                {t("ai:voice.record")}
              </button>
            )}
          </div>

          {empty && <p className="text-sm text-fg-faint">{t("empty")}</p>}

          {focus === today && overdue.length > 0 && (
            <Group label={t("overdue")} danger>
              {overdue.map((i) => (
                <TaskRow key={i.refId} item={i} onToggle={toggleTask} onOpen={openSource} />
              ))}
            </Group>
          )}

          {events.length > 0 && (
            <Group label={t("events")}>
              {events.map((i) => (
                <EventRow key={i.refId} item={i} time={timeOf(i.start)} timeFormat={timeFormat} onOpen={openSource} />
              ))}
            </Group>
          )}

          {tasks.length > 0 && (
            <Group label={t("tasks")}>
              {tasks.map((i) => (
                <TaskRow key={i.refId} item={i} onToggle={toggleTask} onOpen={openSource} />
              ))}
            </Group>
          )}
        </div>
      </div>
    </section>
  );
}

function Group({ label, danger, children }: { label: string; danger?: boolean; children: ReactNode }) {
  return (
    <section>
      <h3
        className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${
          danger ? "text-danger" : "text-fg-faint"
        }`}
      >
        {label}
      </h3>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

function TaskRow({
  item,
  onToggle,
  onOpen,
}: {
  item: AgendaItem;
  onToggle: (id: string) => void;
  onOpen: (notePath: string | null) => void;
}) {
  return (
    <div className="flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-hover">
      <input
        type="checkbox"
        onChange={() => onToggle(item.refId)}
        className="mt-1 accent-[var(--accent)]"
      />
      <button
        onClick={() => onOpen(item.notePath)}
        className="min-w-0 flex-1 truncate text-left text-sm text-fg"
      >
        {displayText(item.title)}
      </button>
    </div>
  );
}

function EventRow({
  item,
  time,
  timeFormat,
  onOpen,
}: {
  item: AgendaItem;
  time: string | null;
  timeFormat: "12h" | "24h";
  onOpen: (notePath: string | null) => void;
}) {
  return (
    <button
      onClick={() => onOpen(item.notePath)}
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-hover"
    >
      <span className="w-12 shrink-0 text-xs tabular-nums text-fg-faint">
        {time ? formatTime(time, timeFormat) : null}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-fg">{item.title}</span>
    </button>
  );
}
