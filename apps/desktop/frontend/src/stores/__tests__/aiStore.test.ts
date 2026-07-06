// Regression tests for the streaming-panel race: `ai-stream-*` events that
// arrive before `aiRunAction` resolves with the run's id must be buffered and
// replayed, not dropped (a dropped early error left the panel spinning
// forever). The ipc module is mocked, so no Tauri runtime is needed.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The store reads localStorage at module-eval time; Node has no DOM Storage.
vi.hoisted(() => {
  const backing = new Map<string, string>();
  const stub = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: () => null,
    length: 0,
  };
  // Node exposes `localStorage` as a getter-only accessor (undefined without
  // --experimental-webstorage), so plain assignment won't stick — redefine it.
  Object.defineProperty(globalThis, "localStorage", { value: stub, configurable: true });
});

const aiRunAction = vi.fn<(req: unknown) => Promise<string>>();
const aiCancel = vi.fn<(id: string) => Promise<null>>(() => Promise.resolve(null));

vi.mock("../../ipc/api", () => {
  const listen = () => Promise.resolve(() => {});
  return {
    api: {
      aiRunAction: (req: unknown) => aiRunAction(req),
      aiCancel: (id: string) => aiCancel(id),
    },
    events: {
      aiStreamChunk: { listen },
      aiStreamDone: { listen },
      aiStreamError: { listen },
    },
  };
});

vi.mock("@novalis/editor", () => ({ getMarkdown: () => "" }));

const { useAi } = await import("../aiStore");

const startArgs = {
  connectionId: "conn-1",
  actionId: "summarize",
  title: "Summarize note",
  notePath: "a.md",
  context: { title: "A", markdown: "", selection: null },
};

describe("aiStore panel-run streaming race", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAi.setState({ run: null });
  });

  it("replays chunks that arrive before the run id is known", async () => {
    let resolveId!: (id: string) => void;
    aiRunAction.mockReturnValue(new Promise((r) => (resolveId = r)));

    const started = useAi.getState().startRun(startArgs);
    // Events beat the invoke result.
    useAi.getState().appendChunk("req-1", "hel");
    useAi.getState().appendChunk("req-1", "lo");
    expect(useAi.getState().run?.text).toBe("");

    resolveId("req-1");
    await started;

    const run = useAi.getState().run;
    expect(run?.id).toBe("req-1");
    expect(run?.text).toBe("hello");
    expect(run?.status).toBe("streaming");

    // The direct path still works once the id is known.
    useAi.getState().appendChunk("req-1", "!");
    expect(useAi.getState().run?.text).toBe("hello!");
  });

  it("replays an early error so the panel is not stuck streaming", async () => {
    let resolveId!: (id: string) => void;
    aiRunAction.mockReturnValue(new Promise((r) => (resolveId = r)));

    const started = useAi.getState().startRun(startArgs);
    // e.g. CLI binary missing: the backend fails before the invoke resolves.
    useAi.getState().failRun("req-1", "claude binary not found");

    resolveId("req-1");
    await started;

    const run = useAi.getState().run;
    expect(run?.status).toBe("error");
    expect(run?.error).toBe("claude binary not found");
  });

  it("replays an early completion", async () => {
    let resolveId!: (id: string) => void;
    aiRunAction.mockReturnValue(new Promise((r) => (resolveId = r)));

    const started = useAi.getState().startRun(startArgs);
    useAi.getState().appendChunk("req-1", "done text");
    useAi.getState().finishRun("req-1");

    resolveId("req-1");
    await started;

    const run = useAi.getState().run;
    expect(run?.status).toBe("done");
    expect(run?.text).toBe("done text");
  });

  it("discards buffered events for other request ids", async () => {
    let resolveId!: (id: string) => void;
    aiRunAction.mockReturnValue(new Promise((r) => (resolveId = r)));

    const started = useAi.getState().startRun(startArgs);
    useAi.getState().appendChunk("other-req", "not ours");
    useAi.getState().failRun("other-req", "someone else's failure");

    resolveId("req-1");
    await started;

    const run = useAi.getState().run;
    expect(run?.id).toBe("req-1");
    expect(run?.text).toBe("");
    expect(run?.status).toBe("streaming");
  });

  it("does not attach a superseded invoke's id to a newer run", async () => {
    let resolveFirst!: (id: string) => void;
    aiRunAction.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
    const first = useAi.getState().startRun(startArgs);

    // A second run replaces the first before its invoke resolves.
    aiRunAction.mockResolvedValueOnce("req-2");
    const second = useAi.getState().startRun({ ...startArgs, title: "Second" });
    await second;
    expect(useAi.getState().run?.id).toBe("req-2");

    resolveFirst("req-1");
    await first;
    expect(useAi.getState().run?.id).toBe("req-2");
    expect(useAi.getState().run?.title).toBe("Second");
  });
});
