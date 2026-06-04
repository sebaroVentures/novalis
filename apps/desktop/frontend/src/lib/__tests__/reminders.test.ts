import { describe, expect, it } from "vitest";

import { reminderFireTime } from "../reminders";

describe("reminderFireTime", () => {
  it("parses a local datetime to a timestamp", () => {
    expect(reminderFireTime("2026-06-10T09:00")).toBe(new Date(2026, 5, 10, 9, 0).getTime());
  });

  it("returns null for missing or malformed input", () => {
    expect(reminderFireTime(null)).toBeNull();
    expect(reminderFireTime(undefined)).toBeNull();
    expect(reminderFireTime("2026-06-10")).toBeNull();
    expect(reminderFireTime("garbage")).toBeNull();
  });
});
