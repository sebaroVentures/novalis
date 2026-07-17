import { useEffect, useRef, useState } from "react";

import { ChevronLeft, ChevronRight, Mic } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, type CalendarEvent, type EventDraft } from "../ipc/api";
import {
  formatDateMedium,
  formatDayLong,
  formatTime,
  monthYearLabel,
  weekdayShortNames,
} from "../lib/datetime";
import { type CalMode, gridFor, isoDate, useCalendar } from "../stores/calendarStore";
import { useSettings } from "../stores/settingsStore";
import { useVoice } from "../stores/voiceStore";
import { Modal } from "./ui/Modal";

/** Add minutes to a `HH:MM` string, wrapping within a 24h day. */
function addMinutes(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const norm = (((h * 60 + m + mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(norm / 60)).padStart(2, "0")}:${String(norm % 60).padStart(2, "0")}`;
}

const freqToRrule = (f: string) =>
  f === "none" ? undefined : `FREQ=${f.toUpperCase()}`;
const rruleToFreq = (r?: string | null) => {
  if (!r) return "none";
  const m = r.match(/FREQ=(\w+)/i);
  return m ? m[1].toLowerCase() : "none";
};

export function CalendarView() {
  const mode = useCalendar((s) => s.mode);
  const anchor = useCalendar((s) => s.anchor);
  const events = useCalendar((s) => s.events);
  const error = useCalendar((s) => s.error);
  const calPrefs = useSettings((s) => s.prefs?.calendar);
  const { t } = useTranslation(["calendar", "common"]);
  const [editing, setEditing] = useState<EventDraft | null>(null);

  const weekStart = calPrefs?.weekStart === "sunday" ? "sunday" : "monday";
  const timeFormat = calPrefs?.timeFormat === "12h" ? "12h" : "24h";
  const weekdays = weekdayShortNames(weekStart);

  // Reload when the vault mounts and whenever the week start shifts the grid.
  useEffect(() => {
    void useCalendar.getState().load();
  }, [weekStart]);

  const grid = gridFor(mode, anchor, weekStart);
  const todayIso = isoDate(new Date());
  const headerLabel =
    mode === "month"
      ? monthYearLabel(anchor)
      : mode === "day"
        ? formatDayLong(anchor)
        : `${formatDateMedium(grid[0])} – ${formatDateMedium(grid[grid.length - 1])}`;
  const modes: CalMode[] = ["month", "week", "day"];
  // Static t() calls so i18next-parser keeps these keys (the toggle uses a
  // dynamic key otherwise).
  const modeLabels: Record<CalMode, string> = {
    month: t("month"),
    week: t("week"),
    day: t("day"),
  };

  const eventsOn = (iso: string) =>
    events
      .filter((e) => e.start.slice(0, 10) === iso)
      .sort((a, b) => a.start.localeCompare(b.start));

  const newOn = (iso: string) =>
    setEditing({
      title: "",
      date: iso,
      allDay: false,
      startTime: "09:00",
      endTime: addMinutes("09:00", calPrefs?.defaultEventMinutes ?? 60),
    });

  const edit = (e: CalendarEvent) =>
    setEditing({
      title: e.title,
      date: e.start.slice(0, 10),
      allDay: e.allDay,
      startTime: !e.allDay && e.start.length >= 16 ? e.start.slice(11, 16) : undefined,
      endTime: e.end && !e.allDay && e.end.length >= 16 ? e.end.slice(11, 16) : undefined,
      rrule: e.rrule ?? undefined,
      location: e.location ?? undefined,
      notePath: e.notePath ?? undefined,
      attendees: e.attendees ?? [],
    });

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <button onClick={() => useCalendar.getState().prev()} aria-label={t("prevMonth")} className="rounded px-2 py-1 text-fg-muted hover:bg-hover">
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-40 text-center text-sm font-medium text-fg">{headerLabel}</span>
          <button onClick={() => useCalendar.getState().next()} aria-label={t("nextMonth")} className="rounded px-2 py-1 text-fg-muted hover:bg-hover">
            <ChevronRight size={16} />
          </button>
          <button onClick={() => useCalendar.getState().today()} className="ml-1 rounded px-2 py-1 text-xs text-fg-muted hover:bg-hover">
            {t("today")}
          </button>
        </div>
        <div className="flex items-center gap-1 text-xs">
          <div className="mr-1 flex rounded-md ring-1 ring-border">
            {modes.map((m) => (
              <button
                key={m}
                onClick={() => useCalendar.getState().setMode(m)}
                className={`px-2.5 py-1 transition-colors first:rounded-l-md last:rounded-r-md ${
                  mode === m ? "bg-active text-fg" : "text-fg-muted hover:bg-hover"
                }`}
              >
                {modeLabels[m]}
              </button>
            ))}
          </div>
          <button onClick={() => void api.importIcs().then(() => useCalendar.getState().load())} className="rounded px-2 py-1 text-fg-muted hover:bg-hover">
            {t("importIcs")}
          </button>
          <button
            onClick={() => void api.exportIcs(isoDate(grid[0]), isoDate(grid[grid.length - 1]))}
            className="rounded px-2 py-1 text-fg-muted hover:bg-hover"
          >
            {t("exportIcs")}
          </button>
          <button onClick={() => newOn(todayIso)} className="rounded-md bg-accent px-3 py-1 font-medium text-accent-fg hover:bg-accent">
            {t("newEvent")}
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2 text-sm text-danger">
          <span>{t("loadError")}</span>
          <button
            onClick={() => void useCalendar.getState().load()}
            className="shrink-0 rounded-md px-2 py-1 text-xs ring-1 ring-danger/50 transition-colors hover:bg-danger/10"
          >
            {t("common:retry")}
          </button>
        </div>
      )}

      {mode === "day" ? (
        <div className="flex-1 overflow-y-auto">
          <DayColumn
            day={grid[0]}
            isToday={isoDate(grid[0]) === todayIso}
            events={eventsOn(isoDate(grid[0]))}
            timeFormat={timeFormat}
            onNew={newOn}
            onEdit={edit}
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-7 border-b border-border text-xs text-fg-subtle">
            {weekdays.map((d) => (
              <div key={d} className="px-2 py-1 text-center">
                {d}
              </div>
            ))}
          </div>
          {mode === "week" ? (
            <div className="grid flex-1 grid-cols-7 overflow-y-auto">
              {grid.map((day) => (
                <DayColumn
                  key={isoDate(day)}
                  day={day}
                  isToday={isoDate(day) === todayIso}
                  events={eventsOn(isoDate(day))}
                  timeFormat={timeFormat}
                  onNew={newOn}
                  onEdit={edit}
                />
              ))}
            </div>
          ) : (
            <div className="grid flex-1 grid-cols-7 grid-rows-6">
              {grid.map((day) => {
                const iso = isoDate(day);
                const inMonth = day.getMonth() === anchor.getMonth();
                const isToday = iso === todayIso;
                return (
                  <div
                    key={iso}
                    onClick={() => newOn(iso)}
                    className={`min-h-0 cursor-pointer overflow-hidden border-b border-r border-border/60 p-1 ${
                      inMonth ? "" : "bg-app/60 text-fg-faint"
                    }`}
                  >
                    <div className={`mb-0.5 text-right text-xs ${isToday ? "font-bold text-accent" : "text-fg-subtle"}`}>
                      {day.getDate()}
                    </div>
                    <div className="space-y-0.5">
                      {eventsOn(iso)
                        .slice(0, 4)
                        .map((e) => (
                          <EventChip key={e.id} event={e} timeFormat={timeFormat} onEdit={edit} />
                        ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {editing && (
        <EventModal
          draft={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void useCalendar.getState().load();
          }}
        />
      )}
    </section>
  );
}

/** A single event pill — used in month cells. */
function EventChip({
  event: e,
  timeFormat,
  onEdit,
}: {
  event: CalendarEvent;
  timeFormat: "12h" | "24h";
  onEdit: (e: CalendarEvent) => void;
}) {
  return (
    <button
      onClick={(ev) => {
        ev.stopPropagation();
        onEdit(e);
      }}
      className={`block w-full truncate rounded px-1 py-0.5 text-left text-[11px] ${
        e.sourceId === "local" ? "bg-accent-soft text-accent" : "bg-teal-500/20 text-teal-100"
      }`}
      title={e.title}
    >
      {!e.allDay && e.start.length >= 16 ? `${formatTime(e.start.slice(11, 16), timeFormat)} ` : ""}
      {e.title}
    </button>
  );
}

/** A scrollable single-day column listing its events (week & day views). */
function DayColumn({
  day,
  isToday,
  events,
  timeFormat,
  onNew,
  onEdit,
}: {
  day: Date;
  isToday: boolean;
  events: CalendarEvent[];
  timeFormat: "12h" | "24h";
  onNew: (iso: string) => void;
  onEdit: (e: CalendarEvent) => void;
}) {
  const iso = isoDate(day);
  return (
    <div
      onClick={() => onNew(iso)}
      className="min-h-40 cursor-pointer border-b border-r border-border/60 p-2"
    >
      <div className={`mb-1 text-xs font-medium ${isToday ? "text-accent" : "text-fg-subtle"}`}>
        {day.getDate()}
      </div>
      <div className="space-y-1">
        {events.map((e) => (
          <button
            key={e.id}
            onClick={(ev) => {
              ev.stopPropagation();
              onEdit(e);
            }}
            className={`block w-full truncate rounded px-1.5 py-1 text-left text-xs ${
              e.sourceId === "local" ? "bg-accent-soft text-accent" : "bg-teal-500/20 text-teal-100"
            }`}
            title={e.title}
          >
            {!e.allDay && e.start.length >= 16 ? `${formatTime(e.start.slice(11, 16), timeFormat)} ` : ""}
            {e.title}
          </button>
        ))}
      </div>
    </div>
  );
}

function EventModal({
  draft,
  onClose,
  onSaved,
}: {
  draft: EventDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(["calendar", "common", "ai"]);
  const [d, setD] = useState<EventDraft>(draft);
  const [freq, setFreq] = useState(rruleToFreq(draft.rrule));
  const editing = Boolean(draft.notePath);
  const voiceAvailable = useVoice((s) => s.available);
  const voiceStatus = useVoice((s) => s.status);
  const titleRef = useRef<HTMLInputElement>(null);

  const save = async () => {
    if (!d.title.trim()) return;
    const payload: EventDraft = { ...d, rrule: freqToRrule(freq) };
    try {
      if (editing) await api.updateEvent(payload);
      else await api.createEvent(payload);
      onSaved();
    } catch {
      /* ignore */
    }
  };

  const remove = async () => {
    if (!d.notePath) return;
    try {
      await api.deleteEvent(d.notePath);
      onSaved();
    } catch {
      /* ignore */
    }
  };

  // Materialize a backlinked journal entry + a note per attendee for this event.
  const addMeeting = async () => {
    if (!d.notePath) return;
    try {
      await api.addMeetingNote(d.notePath, d.date);
      onSaved();
    } catch {
      /* ignore */
    }
  };

  return (
    <Modal
      label={editing ? t("editEvent") : t("newEvent")}
      onClose={onClose}
      initialFocusRef={titleRef}
      overlayClassName="z-50 items-center justify-center"
      panelClassName="w-full max-w-sm rounded-xl border border-border-strong bg-surface p-4 shadow-2xl"
    >
      <h2 className="mb-3 text-sm font-semibold text-fg">{editing ? t("editEvent") : t("newEvent")}</h2>
      <div className="space-y-2">
        <input
          ref={titleRef}
          value={d.title}
          onChange={(e) => setD({ ...d, title: e.target.value })}
          placeholder={t("eventTitle")}
          className="w-full rounded bg-surface-2 px-2 py-1.5 text-sm text-fg placeholder:text-fg-faint"
        />
        <input
          type="date"
          value={d.date}
          onChange={(e) => setD({ ...d, date: e.target.value })}
          className="w-full rounded bg-surface-2 px-2 py-1.5 text-sm text-fg"
        />
        <label className="flex items-center gap-2 text-sm text-fg-muted">
          <input type="checkbox" checked={d.allDay} onChange={(e) => setD({ ...d, allDay: e.target.checked })} className="accent-[var(--accent)]" />
          {t("allDay")}
        </label>
        {!d.allDay && (
          <div className="flex gap-2">
            <input
              type="time"
              value={d.startTime ?? ""}
              onChange={(e) => setD({ ...d, startTime: e.target.value })}
              className="flex-1 rounded bg-surface-2 px-2 py-1.5 text-sm text-fg"
            />
            <input
              type="time"
              value={d.endTime ?? ""}
              onChange={(e) => setD({ ...d, endTime: e.target.value })}
              className="flex-1 rounded bg-surface-2 px-2 py-1.5 text-sm text-fg"
            />
          </div>
        )}
        <div className="flex gap-2">
          <select value={freq} onChange={(e) => setFreq(e.target.value)} className="rounded bg-surface-2 px-2 py-1.5 text-sm text-fg">
            <option value="none">{t("freq.none")}</option>
            <option value="daily">{t("freq.daily")}</option>
            <option value="weekly">{t("freq.weekly")}</option>
            <option value="monthly">{t("freq.monthly")}</option>
            <option value="yearly">{t("freq.yearly")}</option>
          </select>
          <input
            value={d.location ?? ""}
            onChange={(e) => setD({ ...d, location: e.target.value })}
            placeholder={t("location")}
            className="flex-1 rounded bg-surface-2 px-2 py-1.5 text-sm text-fg placeholder:text-fg-faint"
          />
        </div>
        <input
          value={(d.attendees ?? []).join(", ")}
          onChange={(e) =>
            setD({
              ...d,
              attendees: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
          placeholder={t("attendees")}
          className="w-full rounded bg-surface-2 px-2 py-1.5 text-sm text-fg placeholder:text-fg-faint"
        />
      </div>
      <div className="mt-4 flex items-center justify-between">
        {editing ? (
          <div className="flex items-center gap-3">
            <button onClick={() => void addMeeting()} className="text-xs text-fg-muted hover:text-fg">
              {t("addMeetingNote")}
            </button>
            {voiceAvailable && (
              <button
                onClick={() => {
                  void useVoice.getState().start();
                  onClose();
                }}
                disabled={voiceStatus !== "idle"}
                title={t("ai:voice.tooltip")}
                className="flex items-center gap-1 text-xs text-fg-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Mic size={12} />
                {t("ai:voice.record")}
              </button>
            )}
            <button onClick={() => void remove()} className="text-xs text-danger hover:text-danger">
              {t("common:delete")}
            </button>
          </div>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-fg-muted hover:text-fg">
            {t("common:cancel")}
          </button>
          <button onClick={() => void save()} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent">
            {t("common:save")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
