// gitConflictStore: staleness-tokened load, per-path resolution bookkeeping
// (including the wire format finalize sends), and the flush-before-finalize
// invariant — finalizing checks out the merged tree over the worktree, so it
// must NEVER proceed while any pane's save failed. The ipc module is mocked,
// so no Tauri runtime is needed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gitMergeConflicts: vi.fn<() => Promise<unknown>>(),
  gitFinalizeMerge: vi.fn<(r: unknown) => Promise<unknown>>(),
  flushActive: vi.fn<() => Promise<void>>(),
  saveStates: new Map<string, string>(),
  saveErrors: new Map<string, string>(),
}));

vi.mock("../../ipc/api", () => ({
  api: {
    gitMergeConflicts: mocks.gitMergeConflicts,
    gitFinalizeMerge: (r: unknown) => mocks.gitFinalizeMerge(r),
  },
}));

// The store only reads the flush registry surface of vaultStore.
vi.mock("../vaultStore", () => ({
  useVault: {
    getState: () => ({
      flushActive: mocks.flushActive,
      saveStates: mocks.saveStates,
      saveErrors: mocks.saveErrors,
    }),
  },
}));

// Key-echoing t(): assertions match keys, not English copy.
vi.mock("../../lib/i18n", () => ({ default: { t: (key: string) => key } }));

import type { GitConflict } from "../../ipc/api";
import { useGitConflicts } from "../gitConflictStore";

function conflict(path: string, over?: Partial<GitConflict>): GitConflict {
  return { path, base: "base", ours: "mine", theirs: "theirs", ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveStates = new Map();
  mocks.saveErrors = new Map();
  mocks.flushActive.mockResolvedValue(undefined);
  useGitConflicts.setState({
    open: false,
    loading: false,
    conflicts: [],
    choices: new Map(),
    finalizing: false,
    error: null,
  });
});

describe("gitConflictStore.load", () => {
  it("ignores a stale load that resolves after a newer one", async () => {
    let resolveFirst!: (v: GitConflict[]) => void;
    mocks.gitMergeConflicts
      .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
      .mockImplementationOnce(() => Promise.resolve([conflict("new.md")]));

    const first = useGitConflicts.getState().load();
    const second = useGitConflicts.getState().load();
    await second;
    // The OLDER load resolves last — its result must be discarded.
    resolveFirst([conflict("stale.md")]);
    await first;

    expect(useGitConflicts.getState().conflicts.map((c) => c.path)).toEqual(["new.md"]);
    expect(useGitConflicts.getState().loading).toBe(false);
  });

  it("clears previous choices when the list reloads", async () => {
    mocks.gitMergeConflicts.mockResolvedValue([conflict("a.md")]);
    useGitConflicts.getState().choose("a.md", { kind: "ours" });
    await useGitConflicts.getState().load();
    expect(useGitConflicts.getState().choices.size).toBe(0);
  });

  it("surfaces a load failure and empties the list", async () => {
    mocks.gitMergeConflicts.mockRejectedValue(new Error("boom"));
    await useGitConflicts.getState().load();
    const s = useGitConflicts.getState();
    expect(s.conflicts).toEqual([]);
    expect(s.error).toContain("boom");
    expect(s.loading).toBe(false);
  });

  it("openResolver opens the modal and loads the list", async () => {
    mocks.gitMergeConflicts.mockResolvedValue([conflict("a.md")]);
    useGitConflicts.getState().openResolver();
    expect(useGitConflicts.getState().open).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(useGitConflicts.getState().conflicts).toHaveLength(1);
  });
});

describe("gitConflictStore.finalize", () => {
  it("maps choices to the wire format and closes on success", async () => {
    useGitConflicts.setState({
      open: true,
      conflicts: [conflict("a.md"), conflict("b.md"), conflict("c.md")],
    });
    const s = useGitConflicts.getState();
    s.choose("a.md", { kind: "ours" });
    s.choose("b.md", { kind: "theirs" });
    s.choose("c.md", { kind: "manual", content: "merged by hand" });
    mocks.gitFinalizeMerge.mockResolvedValue(null);

    await useGitConflicts.getState().finalize();

    expect(mocks.flushActive).toHaveBeenCalledTimes(1);
    expect(mocks.gitFinalizeMerge).toHaveBeenCalledWith([
      { path: "a.md", resolution: "ours" },
      { path: "b.md", resolution: "theirs" },
      { path: "c.md", resolution: { manual: { content: "merged by hand" } } },
    ]);
    const after = useGitConflicts.getState();
    expect(after.open).toBe(false);
    expect(after.conflicts).toEqual([]);
    expect(after.finalizing).toBe(false);
  });

  it("does nothing while any path is unresolved", async () => {
    useGitConflicts.setState({ open: true, conflicts: [conflict("a.md"), conflict("b.md")] });
    useGitConflicts.getState().choose("a.md", { kind: "ours" });

    await useGitConflicts.getState().finalize();

    expect(mocks.gitFinalizeMerge).not.toHaveBeenCalled();
    expect(mocks.flushActive).not.toHaveBeenCalled();
    expect(useGitConflicts.getState().open).toBe(true);
  });

  it("aborts with an error when a pane's save failed — never finalizes over it", async () => {
    useGitConflicts.setState({ open: true, conflicts: [conflict("a.md")] });
    useGitConflicts.getState().choose("a.md", { kind: "ours" });
    // flushActive ran, but one pane's write failed: its only copy lives in
    // that editor, and the merge checkout would overwrite it on disk.
    mocks.saveStates = new Map([["note.md", "error"]]);

    await useGitConflicts.getState().finalize();

    expect(mocks.flushActive).toHaveBeenCalledTimes(1);
    expect(mocks.gitFinalizeMerge).not.toHaveBeenCalled();
    const s = useGitConflicts.getState();
    expect(s.open).toBe(true);
    expect(s.finalizing).toBe(false);
    expect(s.error).toBe("settings:sync.merge.unsavedError");
  });

  it("keeps the modal open and surfaces the message when finalize fails", async () => {
    useGitConflicts.setState({ open: true, conflicts: [conflict("a.md")] });
    useGitConflicts.getState().choose("a.md", { kind: "ours" });
    mocks.gitFinalizeMerge.mockRejectedValue(new Error("push rejected"));

    await useGitConflicts.getState().finalize();

    const s = useGitConflicts.getState();
    expect(s.open).toBe(true);
    expect(s.finalizing).toBe(false);
    expect(s.error).toContain("push rejected");
  });
});
