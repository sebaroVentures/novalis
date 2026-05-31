// Locale-aware date/time formatting bound to the active i18n language, so the
// calendar's weekday / month / time rendering follows the chosen language
// instead of hardcoded English. The pseudo-locale (en-XA) has no CLDR data, so
// it formats as English.

import i18n from "./i18n";

function activeLocale(): string {
  return i18n.language === "en-XA" ? "en" : i18n.language || "en";
}

// 2024-01-01 (UTC) was a Monday — a stable reference for building weekday names.
const MONDAY_REF_UTC = Date.UTC(2024, 0, 1);
const DAY_MS = 86_400_000;

/** Localized short weekday names, ordered for the given week start. Replaces the
 *  hardcoded ["Mon"…"Sun"] array and its Sunday-first reorder in CalendarView. */
export function weekdayShortNames(weekStart: "monday" | "sunday"): string[] {
  const fmt = new Intl.DateTimeFormat(activeLocale(), { weekday: "short", timeZone: "UTC" });
  const mondayFirst = Array.from({ length: 7 }, (_, i) =>
    fmt.format(new Date(MONDAY_REF_UTC + i * DAY_MS)),
  );
  return weekStart === "sunday" ? [mondayFirst[6], ...mondayFirst.slice(0, 6)] : mondayFirst;
}

/** Localized "Month YYYY" header label. */
export function monthYearLabel(date: Date): string {
  return new Intl.DateTimeFormat(activeLocale(), { month: "long", year: "numeric" }).format(date);
}

/** Format a 24h `HH:MM` string in the chosen time format. 24-hour is returned
 *  verbatim (locale-neutral); 12-hour uses the locale's AM/PM markers. */
export function formatTime(hhmm: string, fmt: "12h" | "24h"): string {
  if (fmt !== "12h") return hhmm;
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(2000, 0, 1, h, m);
  return new Intl.DateTimeFormat(activeLocale(), {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}
