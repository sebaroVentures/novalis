// @vitest-environment jsdom
//
// The global last-resort handlers must route uncaught window errors and
// unhandled promise rejections into vaultStore.reportError, never throw
// themselves, and drop identical messages inside the dedupe window so a
// rejection loop can't spam the error toast.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/api", () => ({
  api: {},
  NovalisError: class NovalisError extends Error {
    kind: string;
    constructor(err: { kind: string; message: string }) {
      super(err.message);
      this.kind = err.kind;
    }
  },
}));

import { useVault } from "../../stores/vaultStore";
import { installGlobalErrorHandlers } from "../globalErrors";

const reportError = vi.fn();

function dispatchRejection(reason: unknown): void {
  // jsdom has no PromiseRejectionEvent constructor — a plain Event with the
  // `reason` field attached exercises the same listener path.
  const evt = new Event("unhandledrejection") as Event & { reason?: unknown };
  evt.reason = reason;
  window.dispatchEvent(evt);
}

beforeAll(() => {
  // Idempotence: a second install must not stack a second pair of listeners.
  installGlobalErrorHandlers();
  installGlobalErrorHandlers();
});

beforeEach(() => {
  reportError.mockReset();
  useVault.setState({ reportError });
  // Fake Date so the dedupe window is controllable per test.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("installGlobalErrorHandlers", () => {
  it("routes an unhandledrejection to reportError exactly once (install is idempotent)", () => {
    const reason = new Error("rejection-a");
    dispatchRejection(reason);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(reason);
  });

  it("routes a window error event's error object to reportError", () => {
    const err = new Error("window-error-a");
    window.dispatchEvent(new ErrorEvent("error", { error: err, message: err.message }));
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(err);
  });

  it("dedupes identical messages inside the window, reports again after it", () => {
    dispatchRejection(new Error("looping"));
    dispatchRejection(new Error("looping"));
    expect(reportError).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6_000);
    dispatchRejection(new Error("looping"));
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("does not dedupe distinct messages", () => {
    dispatchRejection(new Error("distinct-a"));
    dispatchRejection(new Error("distinct-b"));
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("swallows a throwing reportError instead of re-raising from the handler", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    reportError.mockImplementation(() => {
      throw new Error("store not ready");
    });
    expect(() => dispatchRejection(new Error("during-boot"))).not.toThrow();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
