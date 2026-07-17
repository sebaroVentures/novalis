// In-app reminder + event-start scheduler. While the app is running it polls
// open tasks and upcoming calendar events and, when a task's @remind time or an
// event's (start − lead) elapses, shows an in-app toast (always) plus a
// best-effort OS notification (tauri-plugin-notification). Reminders/events that
// elapsed while the app was closed are not fired live; instead a "while you were
// away" digest is surfaced once on launch (runLaunchDigest) by comparing the
// persisted per-vault baseline against the current time. The baseline is
// device-local (localStorage) — background scheduling would need OS-level
// integration, which is out of scope here.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { api } from "../ipc/api";
import { useSettings } from "../stores/settingsStore";
import { usePlugins } from "../stores/pluginStore";
import i18n from "./i18n";
import { reminderFireTime } from "./reminders";
import { displayText } from "./taskDisplay";

let activeVault: string | null = null;
let lastCheck = 0;
const fired = new Set<string>();
let askedPermission = false;

async function osAllowed(): Promise<boolean> {
  try {
    let granted = await isPermissionGranted();
    if (!granted && !askedPermission) {
      askedPermission = true;
      granted = (await requestPermission()) === "granted";
    }
    return granted;
  } catch {
    return false;
  }
}

/** localStorage key for a vault's last-seen baseline. Per-vault (each vault has
 *  its own tasks/events) and per-device (a plain wall-clock mirror, never
 *  synced into the vault). */
function baselineKey(vault: string): string {
  return `novalis:reminderBaseline:${vault}`;
}

function loadBaseline(vault: string): number | null {
  try {
    const raw = localStorage.getItem(baselineKey(vault));
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function saveBaseline(vault: string, ts: number): void {
  try {
    localStorage.setItem(baselineKey(vault), String(ts));
  } catch {
    /* quota / private-mode — degrades to "no digest", never throws */
  }
}

/** Local `YYYY-MM-DD` for an epoch ms — matches the local semantics of a
 *  calendar event's `start` field. */
function isoDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Configured event-start lead time in ms (0 = at start). */
function eventLeadMs(): number {
  const mins = useSettings.getState().prefs?.calendar?.eventNotifyLeadMinutes ?? 10;
  return Math.max(0, mins) * 60_000;
}

/** Bind the scheduler to a vault and seed the live-poll baseline from the
 *  persisted value (or "now" for a vault never seen on this device, so a fresh
 *  vault doesn't retroactively fire). Call when a vault opens. */
export function resetReminderBaseline(vaultPath: string): void {
  activeVault = vaultPath;
  fired.clear();
  lastCheck = loadBaseline(vaultPath) ?? Date.now();
}

/** On launch, surface a single "while you were away" digest for reminders and
 *  timed event starts that elapsed between the persisted baseline and now, then
 *  advance the baseline so nothing re-fires next launch or in the live poll.
 *  Idempotent: the baseline is advanced up-front, so a second call (e.g. React
 *  StrictMode's double-invoke) finds an empty window. */
export async function runLaunchDigest(): Promise<void> {
  const vault = activeVault;
  if (!vault) return;

  const now = Date.now();
  const since = lastCheck;
  // Advance + persist first so the live poller and any re-entrant call observe
  // an already-closed window — each missed item is reported exactly once.
  lastCheck = now;
  saveBaseline(vault, now);
  if (since <= 0 || since >= now) return; // fresh vault / nothing elapsed

  const tasks = (await api.listTasks("open").catch(() => null)) ?? [];
  const missedReminders = tasks.filter((t) => {
    const at = reminderFireTime(t.remind);
    if (at === null || at <= since || at > now) return false;
    const key = `r:${t.id}:${t.remind}`;
    if (fired.has(key)) return false;
    fired.add(key);
    return true;
  });

  // Only timed events have a start instant — reminderFireTime returns null for
  // all-day `YYYY-MM-DD` starts, so they're skipped.
  const events = (await api.listEvents(isoDate(since), isoDate(now)).catch(() => null)) ?? [];
  const missedEvents = events.filter((e) => {
    const at = reminderFireTime(e.start);
    if (at === null || at <= since || at > now) return false;
    const key = `e:${e.id}:${e.start}`;
    if (fired.has(key)) return false;
    fired.add(key);
    return true;
  });

  const total = missedReminders.length + missedEvents.length;
  if (total === 0) return;

  const parts: string[] = [];
  if (missedReminders.length > 0)
    parts.push(
      i18n.t("common:notifications.digestReminders", { count: missedReminders.length }),
    );
  if (missedEvents.length > 0)
    parts.push(i18n.t("common:notifications.digestEvents", { count: missedEvents.length }));
  const summary = parts.join(", ");
  const title = i18n.t("common:notifications.digestTitle");

  usePlugins.getState().notify(`${title} — ${summary}`);
  if (await osAllowed()) {
    // Detail lines are user content (task/event titles), so they aren't i18n'd.
    const lines = [
      ...missedReminders.map((t) => `⏰ ${displayText(t.text)}`),
      ...missedEvents.map((e) => `📅 ${e.title}`),
    ];
    try {
      sendNotification({ title, body: `${summary}\n${lines.join("\n")}` });
    } catch {
      /* best-effort — the in-app toast already fired */
    }
  }
}

/** Fire any task reminder whose @remind time, or timed event whose (start −
 *  lead), elapsed since the previous check: an in-app toast always, plus a
 *  best-effort OS notification. Advances (and persists) the baseline each tick
 *  so the launch digest starts from the last live observation. */
export async function checkReminders(): Promise<void> {
  const now = Date.now();
  const since = lastCheck || now;
  lastCheck = now;
  if (activeVault) saveBaseline(activeVault, now);

  const lead = eventLeadMs();

  const tasks = await api.listTasks("open").catch(() => null);
  const dueReminders = (tasks ?? []).filter((t) => {
    const at = reminderFireTime(t.remind);
    return at !== null && at > since && at <= now && !fired.has(`r:${t.id}:${t.remind}`);
  });

  // Notify when (start − lead) crosses this window; fetch far enough ahead to
  // cover the lead (and a day-boundary crossing at up to 15 min lead).
  const events = await api.listEvents(isoDate(since), isoDate(now + lead)).catch(() => null);
  const dueEvents = (events ?? []).filter((e) => {
    const at = reminderFireTime(e.start);
    if (at === null) return false;
    const fireAt = at - lead;
    return fireAt > since && fireAt <= now && !fired.has(`e:${e.id}:${e.start}`);
  });

  if (dueReminders.length === 0 && dueEvents.length === 0) return;

  const allowOs = await osAllowed();
  const notifyOne = (key: string, toast: string, body: string) => {
    fired.add(key);
    usePlugins.getState().notify(toast);
    if (allowOs) {
      try {
        sendNotification({ title: "Novalis", body });
      } catch {
        /* best-effort — the in-app toast already fired */
      }
    }
  };

  for (const t of dueReminders) {
    const title = displayText(t.text);
    notifyOne(`r:${t.id}:${t.remind}`, `⏰ ${title}`, title);
  }
  for (const e of dueEvents) {
    notifyOne(`e:${e.id}:${e.start}`, `📅 ${e.title}`, e.title);
  }
}
