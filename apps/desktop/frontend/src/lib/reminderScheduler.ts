// In-app reminder scheduler. While the app is running it polls open tasks and,
// when a task's @remind time elapses, shows an in-app toast (always) plus a
// best-effort OS notification (tauri-plugin-notification). Reminders that
// elapsed while the app was closed are not fired retroactively — background
// scheduling would need OS-level integration, which is out of scope here.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

import { api } from "../ipc/api";
import { usePlugins } from "../stores/pluginStore";
import { reminderFireTime } from "./reminders";
import { displayText } from "./taskDisplay";

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

/** Baseline "now" so reminders that already elapsed (e.g. while the app was
 *  closed) aren't fired retroactively on startup. Call when a vault opens. */
export function resetReminderBaseline(): void {
  lastCheck = Date.now();
}

/** Fire any task reminder whose time elapsed since the previous check: an
 *  in-app toast always, plus a best-effort OS notification. */
export async function checkReminders(): Promise<void> {
  const now = Date.now();
  const since = lastCheck || now;
  lastCheck = now;

  const tasks = await api.listTasks("open").catch(() => null);
  if (!tasks) return;

  const due = tasks.filter((t) => {
    const at = reminderFireTime(t.remind);
    return at !== null && at > since && at <= now && !fired.has(`${t.id}:${t.remind}`);
  });
  if (due.length === 0) return;

  const allowOs = await osAllowed();
  for (const t of due) {
    fired.add(`${t.id}:${t.remind}`);
    const title = displayText(t.text);
    usePlugins.getState().notify(`⏰ ${title}`);
    if (allowOs) {
      try {
        sendNotification({ title: "Novalis", body: title });
      } catch {
        /* best-effort — the in-app toast already fired */
      }
    }
  }
}
