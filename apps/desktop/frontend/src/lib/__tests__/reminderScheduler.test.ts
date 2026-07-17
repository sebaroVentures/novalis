// Scheduler behavior contract: the launch digest reports each reminder/event
// that elapsed while the app was closed exactly once (the persisted baseline
// advances so it never re-fires), the live poll notifies for an event inside
// its lead-time window, and a denied OS-notification permission degrades to the
// in-app toast without throwing. The ipc / notification / store modules are
// mocked, so no Tauri runtime is needed; module state is reset per test via
// vi.resetModules + a dynamic import.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Node has no DOM Storage; stub localStorage on globalThis (see
// stores/__tests__/keymapStore.test.ts for the getter-only accessor detail).
const storage = vi.hoisted(() => {
  const backing = new Map<string, string>();
  const stub = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: () => null,
    length: 0,
  };
  Object.defineProperty(globalThis, "localStorage", { value: stub, configurable: true });
  return stub;
});

const mocks = vi.hoisted(() => ({
  listTasks: vi.fn(),
  listEvents: vi.fn(),
  notify: vi.fn(),
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
  lead: { value: 10 },
}));

vi.mock("../../ipc/api", () => ({
  api: { listTasks: mocks.listTasks, listEvents: mocks.listEvents },
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: mocks.isPermissionGranted,
  requestPermission: mocks.requestPermission,
  sendNotification: mocks.sendNotification,
}));

vi.mock("../../stores/pluginStore", () => ({
  usePlugins: { getState: () => ({ notify: mocks.notify }) },
}));

vi.mock("../../stores/settingsStore", () => ({
  useSettings: {
    getState: () => ({ prefs: { calendar: { eventNotifyLeadMinutes: mocks.lead.value } } }),
  },
}));

const VAULT = "/vault";
const MIN = 60_000;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local `YYYY-MM-DDTHH:MM` for a Date — the format @remind / timed event
 *  starts use (parsed as local by reminderFireTime). */
function localDT(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function task(id: string, remind: string | null) {
  return { id, text: id, remind };
}

function event(id: string, start: string, allDay = false) {
  return { id, title: id, start, allDay };
}

async function loadScheduler() {
  return import("../reminderScheduler");
}

beforeEach(() => {
  vi.resetModules();
  storage.clear();
  mocks.listTasks.mockReset().mockResolvedValue([]);
  mocks.listEvents.mockReset().mockResolvedValue([]);
  mocks.notify.mockReset();
  mocks.sendNotification.mockReset();
  mocks.isPermissionGranted.mockReset().mockResolvedValue(true);
  mocks.requestPermission.mockReset().mockResolvedValue("granted");
  mocks.lead.value = 10;
});

describe("runLaunchDigest", () => {
  it("reports a reminder that elapsed while away exactly once and advances the baseline", async () => {
    const now = Date.now();
    localStorage.setItem(`novalis:reminderBaseline:${VAULT}`, String(now - 60 * MIN));
    mocks.listTasks.mockResolvedValue([task("Buy milk", localDT(new Date(now - 30 * MIN)))]);

    const s = await loadScheduler();
    s.resetReminderBaseline(VAULT);
    await s.runLaunchDigest();

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);

    // Baseline advanced to ~now, so a second launch computes an empty window.
    const persisted = Number(localStorage.getItem(`novalis:reminderBaseline:${VAULT}`));
    expect(persisted).toBeGreaterThanOrEqual(now);

    await s.runLaunchDigest();
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("includes a timed event start that elapsed while away", async () => {
    const now = Date.now();
    localStorage.setItem(`novalis:reminderBaseline:${VAULT}`, String(now - 60 * MIN));
    mocks.listEvents.mockResolvedValue([event("Standup", localDT(new Date(now - 20 * MIN)))]);

    const s = await loadScheduler();
    s.resetReminderBaseline(VAULT);
    await s.runLaunchDigest();

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("shows nothing for a fresh vault with no persisted baseline", async () => {
    mocks.listTasks.mockResolvedValue([task("Buy milk", localDT(new Date(Date.now() - 30 * MIN)))]);

    const s = await loadScheduler();
    s.resetReminderBaseline(VAULT); // no localStorage entry → baseline = now
    await s.runLaunchDigest();

    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});

describe("checkReminders", () => {
  it("notifies for an event inside its lead-time window", async () => {
    const now = Date.now();
    mocks.lead.value = 10;
    localStorage.setItem(`novalis:reminderBaseline:${VAULT}`, String(now - 5 * MIN));
    // Starts in 6 min → fires at (start − 10 min) ≈ 4 min ago, inside (−5 min, now].
    mocks.listEvents.mockResolvedValue([event("Meeting", localDT(new Date(now + 6 * MIN)))]);

    const s = await loadScheduler();
    s.resetReminderBaseline(VAULT);
    await s.checkReminders();

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
  });

  it("ignores all-day events (no start instant)", async () => {
    const now = Date.now();
    mocks.lead.value = 0;
    localStorage.setItem(`novalis:reminderBaseline:${VAULT}`, String(now - 5 * MIN));
    const today = localDT(new Date(now)).slice(0, 10); // YYYY-MM-DD
    mocks.listEvents.mockResolvedValue([event("Holiday", today, true)]);

    const s = await loadScheduler();
    s.resetReminderBaseline(VAULT);
    await s.checkReminders();

    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("does not throw and skips OS notification when permission is denied", async () => {
    const now = Date.now();
    mocks.isPermissionGranted.mockResolvedValue(false);
    mocks.requestPermission.mockResolvedValue("denied");
    localStorage.setItem(`novalis:reminderBaseline:${VAULT}`, String(now - 5 * MIN));
    mocks.listTasks.mockResolvedValue([task("Call Bob", localDT(new Date(now - 2 * MIN)))]);

    const s = await loadScheduler();
    s.resetReminderBaseline(VAULT);
    await expect(s.checkReminders()).resolves.toBeUndefined();

    // In-app toast still fires; OS notification is suppressed.
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
  });
});
