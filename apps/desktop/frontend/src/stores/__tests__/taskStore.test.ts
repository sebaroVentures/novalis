// Task mutations must never fail silently: every mutation routes its failure
// into vaultStore's global error state (the toast in App.tsx) and leaves the
// loaded list untouched — the UI must not pretend a toggle/move/delete
// happened when the backend rejected it. Also covers load()'s monotonic
// staleness token: a slow earlier response must not overwrite a newer one.
// The ipc module is mocked, so no Tauri runtime is needed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listTasks: vi.fn(),
  getPreferences: vi.fn(),
  toggleTask: vi.fn(),
  setTaskStatus: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  moveTask: vi.fn(),
  createTask: vi.fn(),
}));

vi.mock("../../ipc/api", () => ({
  api: { ...mocks },
  NovalisError: class NovalisError extends Error {
    kind: string;
    constructor(err: { kind: string; message: string }) {
      super(err.message);
      this.kind = err.kind;
    }
  },
}));

import type { Task } from "../../ipc/api";
import { DEFAULT_COLUMNS, EMPTY_BOARD_FILTER, useTasks } from "../taskStore";
import { useVault } from "../vaultStore";

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    text: id,
    completed: false,
    priority: null,
    dueDate: null,
    status: null,
    sourceNote: "notes/a.md",
    sourceLine: 1,
    tags: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  useTasks.setState({
    tasks: [],
    filter: "open",
    mode: "list",
    modeInitialized: true, // seeding-from-prefs is not under test here
    columns: DEFAULT_COLUMNS,
    loading: false,
    error: null,
    boardFilter: EMPTY_BOARD_FILTER,
    cardMenu: null,
  });
  useVault.setState({ error: null });
});

describe("taskStore.load staleness token", () => {
  it("drops a stale response that resolves after a newer load (last call wins)", async () => {
    const first = deferred<Task[]>();
    const second = deferred<Task[]>();
    mocks.listTasks.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    mocks.getPreferences.mockResolvedValue({});

    const load1 = useTasks.getState().load();
    const load2 = useTasks.getState().load();

    second.resolve([task("newer")]);
    await load2;
    expect(useTasks.getState().tasks.map((t) => t.id)).toEqual(["newer"]);
    expect(useTasks.getState().loading).toBe(false);

    // The slow first response lands afterwards — it must be discarded.
    first.resolve([task("stale")]);
    await load1;
    expect(useTasks.getState().tasks.map((t) => t.id)).toEqual(["newer"]);
    expect(useTasks.getState().loading).toBe(false);
  });

  it("records an error when the load fails, and clears it on the next successful load", async () => {
    mocks.listTasks.mockRejectedValueOnce(new Error("engine gone"));
    mocks.getPreferences.mockResolvedValue({});

    await useTasks.getState().load();

    // An empty board must read as a failure, not a legitimately empty task list.
    expect(useTasks.getState().tasks).toEqual([]);
    expect(useTasks.getState().loading).toBe(false);
    expect(useTasks.getState().error).toContain("engine gone");

    mocks.listTasks.mockResolvedValue([task("back")]);
    await useTasks.getState().load();

    expect(useTasks.getState().tasks.map((t) => t.id)).toEqual(["back"]);
    expect(useTasks.getState().error).toBeNull();
  });
});

describe("taskStore mutation failures", () => {
  it.each([
    ["toggle", () => useTasks.getState().toggle("t1"), mocks.toggleTask],
    ["setStatus", () => useTasks.getState().setStatus("t1", "done"), mocks.setTaskStatus],
    ["updateField", () => useTasks.getState().updateField("t1", "priority", "A"), mocks.updateTask],
    ["deleteTask", () => useTasks.getState().deleteTask("t1"), mocks.deleteTask],
    ["moveTask", () => useTasks.getState().moveTask("t1", "dest.md"), mocks.moveTask],
    ["addTask", () => useTasks.getState().addTask("buy milk"), mocks.createTask],
  ])("%s surfaces the failure globally and leaves the list untouched", async (_name, run, apiFn) => {
    useTasks.setState({ tasks: [task("t1")] });
    apiFn.mockRejectedValue(new Error("backend rejected the write"));

    await run();

    // Routed into vaultStore's shared error surface (the App.tsx toast) …
    expect(useVault.getState().error).toContain("backend rejected the write");
    // … and no reload happened, so the list still shows reality.
    expect(useTasks.getState().tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(mocks.listTasks).not.toHaveBeenCalled();
  });

  it("keeps the card menu open when a delete fails (the task still exists)", async () => {
    useTasks.setState({ tasks: [task("t1")] });
    useTasks.getState().openCardMenu("t1", 10, 20);
    mocks.deleteTask.mockRejectedValue(new Error("io error"));

    await useTasks.getState().deleteTask("t1");

    expect(useVault.getState().error).toContain("io error");
    expect(useTasks.getState().cardMenu).toEqual({ taskId: "t1", x: 10, y: 20 });
  });

  it("does not call the backend for a whitespace-only addTask", async () => {
    await useTasks.getState().addTask("   ");
    expect(mocks.createTask).not.toHaveBeenCalled();
    expect(useVault.getState().error).toBeNull();
  });
});

describe("taskStore mutation success", () => {
  it("toggle reloads the list from the backend (no optimistic lie)", async () => {
    useTasks.setState({ tasks: [task("t1")] });
    mocks.toggleTask.mockResolvedValue(null);
    mocks.listTasks.mockResolvedValue([task("t1", { completed: true })]);
    mocks.getPreferences.mockResolvedValue({});

    await useTasks.getState().toggle("t1");

    expect(mocks.toggleTask).toHaveBeenCalledWith("t1");
    expect(useTasks.getState().tasks).toEqual([task("t1", { completed: true })]);
    expect(useVault.getState().error).toBeNull();
  });
});
