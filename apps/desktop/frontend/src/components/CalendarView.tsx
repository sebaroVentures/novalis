import { useEffect, useState } from "react";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, type CalendarEvent, type EventDraft } from "../ipc/api";
import { formatTime, monthYearLabel, weekdayShortNames } from "../lib/datetime";
import { isoDate, monthGrid, useCalendar } from "../stores/calendarStore";
import { useSettings } from "../stores/settingsStore";

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
  const month = useCalendar((s) => s.month);
  const events = useCalendar((s) => s.events);
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

  const grid = monthGrid(month, weekStart);
  const todayIso = isoDate(new Date());
  const monthLabel = monthYearLabel(month);

  const eventsOn = (iso: string) => events.filter((e) => e.start.slice(0, 10) === iso);

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
    });

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <button onClick={() => useCalendar.getState().prev()} aria-label={t("prevMonth")} className="rounded px-2 py-1 text-fg-muted hover:bg-hover">
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-40 text-center text-sm font-medium text-fg">{monthLabel}</span>
          <button onClick={() => useCalendar.getState().next()} aria-label={t("nextMonth")} className="rounded px-2 py-1 text-fg-muted hover:bg-hover">
            <ChevronRight size={16} />
          </button>
          <button onClick={() => useCalendar.getState().today()} className="ml-1 rounded px-2 py-1 text-xs text-fg-muted hover:bg-hover">
            {t("today")}
          </button>
        </div>
        <div className="flex items-center gap-1 text-xs">
          <button onClick={() => void api.importIcs().then(() => useCalendar.getState().load())} className="rounded px-2 py-1 text-fg-muted hover:bg-hover">
            {t("importIcs")}
          </button>
          <button
            onClick={() => {
              const g = monthGrid(month, weekStart);
              void api.exportIcs(isoDate(g[0]), isoDate(g[g.length - 1]));
            }}
            className="rounded px-2 py-1 text-fg-muted hover:bg-hover"
          >
            {t("exportIcs")}
          </button>
          <button onClick={() => newOn(todayIso)} className="rounded-md bg-accent px-3 py-1 font-medium text-accent-fg hover:bg-accent">
            {t("newEvent")}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-7 border-b border-border text-xs text-fg-subtle">
        {weekdays.map((d) => (
          <div key={d} className="px-2 py-1 text-center">
            {d}
          </div>
        ))}
      </div>

      <div className="grid flex-1 grid-cols-7 grid-rows-6">
        {grid.map((day) => {
          const iso = isoDate(day);
          const inMonth = day.getMonth() === month.getMonth();
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
                {eventsOn(iso).slice(0, 4).map((e) => (
                  <button
                    key={e.id}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      edit(e);
                    }}
                    className={`block w-full truncate rounded px-1 py-0.5 text-left text-[11px] ${
                      e.sourceId === "local"
                        ? "bg-accent-soft text-accent"
                        : "bg-teal-500/20 text-teal-100"
                    }`}
                    title={e.title}
                  >
                    {!e.allDay && e.start.length >= 16
                      ? `${formatTime(e.start.slice(11, 16), timeFormat)} `
                      : ""}
                    {e.title}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

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

function EventModal({
  draft,
  onClose,
  onSaved,
}: {
  draft: EventDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(["calendar", "common"]);
  const [d, setD] = useState<EventDraft>(draft);
  const [freq, setFreq] = useState(rruleToFreq(draft.rrule));
  const editing = Boolean(draft.notePath);

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-border-strong bg-surface p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-sm font-semibold text-fg">{editing ? t("editEvent") : t("newEvent")}</h2>
        <div className="space-y-2">
          <input
            autoFocus
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
        </div>
        <div className="mt-4 flex items-center justify-between">
          {editing ? (
            <button onClick={() => void remove()} className="text-xs text-danger hover:text-danger">
              {t("common:delete")}
            </button>
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
      </div>
    </div>
  );
}
