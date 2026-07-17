// A settings / saved-query change persists through a debounced write, and must
// never vanish silently: flushPending() forces any pending write to disk before
// a quit within PERSIST_DELAY can drop it, and a failed write is surfaced on the
// global error toast (vaultStore) rather than swallowed. The ipc module is
// mocked, so no Tauri runtime is needed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPreferences: vi.fn(), setPreferences: vi.fn() }));

vi.mock("../../ipc/api", () => ({
  api: { getPreferences: mocks.getPreferences, setPreferences: mocks.setPreferences },
}));

import type { Preferences } from "../../ipc/api";
import { useSettings } from "../settingsStore";
import { useVault } from "../vaultStore";

const emptyPrefs = (): Preferences => ({});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPreferences.mockResolvedValue({});
  mocks.setPreferences.mockResolvedValue(null);
  useSettings.setState({ prefs: emptyPrefs(), loaded: true });
  useVault.setState({ error: null });
});

describe("settingsStore.flushPending", () => {
  it("writes a pending debounced persist immediately (before the timer fires)", async () => {
    useSettings.getState().setSavedQueries([{ name: "q", query: "type:note" }]);
    // Still only scheduled — the debounced timer hasn't fired yet.
    expect(mocks.setPreferences).not.toHaveBeenCalled();

    await useSettings.getState().flushPending();

    expect(mocks.setPreferences).toHaveBeenCalledTimes(1);
    expect(mocks.setPreferences.mock.calls[0][0].savedQueries).toEqual([
      { name: "q", query: "type:note" },
    ]);
  });

  it("is a no-op when nothing is pending (no redundant write on quit)", async () => {
    await useSettings.getState().flushPending();
    expect(mocks.setPreferences).not.toHaveBeenCalled();
  });
});

describe("settingsStore persist failure", () => {
  it("routes a failed write through the global error toast instead of swallowing it", async () => {
    mocks.setPreferences.mockRejectedValue(new Error("disk full"));

    useSettings.getState().setSavedQueries([{ name: "q", query: "type:note" }]);
    await useSettings.getState().flushPending();

    expect(useVault.getState().error).toContain("disk full");
  });
});
