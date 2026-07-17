// @vitest-environment jsdom
//
// A failed agenda load must not render as a legitimately free day: TodayView
// shows an inline retry banner (and suppresses the "nothing scheduled" message)
// while `useAgenda.error` is set, and a successful Retry clears it. The ipc
// module is mocked, so no Tauri runtime is needed.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAgenda: vi.fn(), toggleTask: vi.fn(), createNote: vi.fn() }));

vi.mock("../../ipc/api", () => ({ api: { ...mocks } }));

// A transitive import (voiceStore → aiStore) reads localStorage at module-eval;
// jsdom's here is non-functional, so install a working stub (mirrors aiStore.test).
vi.hoisted(() => {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
      key: () => null,
      length: 0,
    },
    configurable: true,
  });
});

// Initializes the i18next instance synchronously (side effect of import) so the
// banner's translated strings resolve.
import "../../lib/i18n";
import { isoDay, useAgenda } from "../../stores/agendaStore";
import { TodayView } from "../TodayView";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  useAgenda.setState({
    focus: isoDay(new Date()),
    items: [],
    overdue: [],
    loading: false,
    error: null,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const retryButton = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === "Retry");

describe("TodayView load-error banner", () => {
  it("renders a retry banner when the load fails, then clears it on a successful retry", async () => {
    mocks.getAgenda.mockRejectedValue(new Error("engine gone"));

    await act(async () => root.render(<TodayView />));
    await act(async () => {}); // let the mount-effect load settle

    // The failure is surfaced instead of a misleading "free day".
    expect(container.textContent).toContain("Couldn't load your agenda.");
    expect(container.textContent).not.toContain("Nothing scheduled");
    expect(retryButton()).toBeTruthy();

    // Retry succeeds → banner clears and the empty-day copy can show again.
    mocks.getAgenda.mockResolvedValue([]);
    await act(async () => retryButton()!.click());
    await act(async () => {});

    expect(container.textContent).not.toContain("Couldn't load your agenda.");
    expect(useAgenda.getState().error).toBeNull();
  });
});
