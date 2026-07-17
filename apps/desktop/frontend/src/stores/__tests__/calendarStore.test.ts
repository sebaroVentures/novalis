// calendarStore.load's monotonic staleness token: rapid prev/next steps fire
// overlapping fetches, and a slow earlier period's response must not overwrite
// a newer one. reset() (vault switch) bumps the same token so an in-flight
// load from the PREVIOUS vault can never land in the new one. The ipc module
// is mocked, so no Tauri runtime is needed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listEvents: vi.fn() }));

vi.mock("../../ipc/api", () => ({ api: { listEvents: mocks.listEvents } }));

import type { CalendarEvent } from "../../ipc/api";
import { useCalendar } from "../calendarStore";

function event(id: string): CalendarEvent {
  return {
    id,
    sourceId: "local",
    title: id,
    start: "2026-06-02",
    end: null,
    allDay: true,
    rrule: null,
    location: null,
    notePath: null,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

beforeEach(() => {
  mocks.listEvents.mockReset();
  useCalendar.setState({
    mode: "month",
    anchor: new Date(2026, 5, 15), // June 2026; the 1st is a Monday
    events: [],
    loading: false,
    error: null,
  });
});

describe("calendarStore.load", () => {
  it("requests the visible 6-week month grid", async () => {
    mocks.listEvents.mockResolvedValue([]);

    await useCalendar.getState().load();

    // Default week start (monday, no prefs loaded): 2026-06-01 .. +41 days.
    expect(mocks.listEvents).toHaveBeenCalledWith("2026-06-01", "2026-07-12");
  });

  it("drops a stale response that resolves after a newer load (last call wins)", async () => {
    const first = deferred<CalendarEvent[]>();
    const second = deferred<CalendarEvent[]>();
    mocks.listEvents.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const load1 = useCalendar.getState().load();
    const load2 = useCalendar.getState().load();

    second.resolve([event("newer")]);
    await load2;
    expect(useCalendar.getState().events.map((e) => e.id)).toEqual(["newer"]);

    first.resolve([event("stale")]);
    await load1;
    expect(useCalendar.getState().events.map((e) => e.id)).toEqual(["newer"]);
    expect(useCalendar.getState().loading).toBe(false);
  });

  it("reset bumps the token so an in-flight load from the previous vault is dropped", async () => {
    const inflight = deferred<CalendarEvent[]>();
    mocks.listEvents.mockReturnValueOnce(inflight.promise);

    const load = useCalendar.getState().load();
    useCalendar.getState().reset(); // vault switch while the fetch is in flight

    inflight.resolve([event("old-vault")]);
    await load;

    expect(useCalendar.getState().events).toEqual([]);
    expect(useCalendar.getState().loading).toBe(false);
  });

  it("records an error when the fetch fails, and clears it on the next successful load", async () => {
    mocks.listEvents.mockRejectedValueOnce(new Error("engine gone"));

    await useCalendar.getState().load();

    // The empty grid must read as a failure, not a legitimately event-free month.
    expect(useCalendar.getState().events).toEqual([]);
    expect(useCalendar.getState().loading).toBe(false);
    expect(useCalendar.getState().error).toContain("engine gone");

    mocks.listEvents.mockResolvedValue([event("back")]);
    await useCalendar.getState().load();

    expect(useCalendar.getState().events.map((e) => e.id)).toEqual(["back"]);
    expect(useCalendar.getState().error).toBeNull();
  });
});
