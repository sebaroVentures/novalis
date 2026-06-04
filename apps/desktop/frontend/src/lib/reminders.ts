// Reminder time helpers. A task's `@remind` value is an absolute *local*
// datetime ("YYYY-MM-DDTHH:MM"); this turns it into an epoch timestamp the
// reminder scheduler can compare against the clock.

/** Parse a `@remind` value as a local datetime → epoch ms, or null if it's
 *  absent or not a well-formed `YYYY-MM-DDTHH:MM`. */
export function reminderFireTime(remind: string | null | undefined): number | null {
  if (!remind || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(remind)) return null;
  const t = new Date(remind).getTime();
  return Number.isNaN(t) ? null : t;
}
