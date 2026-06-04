import { describe, expect, it } from "vitest";

import { displayText, noteTitleFromPath, topFolderFromPath } from "../taskDisplay";

describe("displayText", () => {
  it("strips every inline annotation (incl. @project/@epic) and #tags", () => {
    const raw =
      "Ship release @start(2026-05-28) @due(2026-06-01) @priority(high) @status(todo) @repeat(weekly) @rrule(FREQ=WEEKLY;BYDAY=MO) @project(work) @epic(q3) #urgent";
    expect(displayText(raw)).toBe("Ship release");
  });

  it("keeps plain text untouched", () => {
    expect(displayText("Just a task")).toBe("Just a task");
  });
});

describe("path helpers", () => {
  it("noteTitleFromPath drops folders and the .md extension", () => {
    expect(noteTitleFromPath("Projects/Work.md")).toBe("Work");
    expect(noteTitleFromPath("Inbox.md")).toBe("Inbox");
  });

  it("topFolderFromPath returns the first segment, or '' at the vault root", () => {
    expect(topFolderFromPath("Projects/Sub/Work.md")).toBe("Projects");
    expect(topFolderFromPath("Root.md")).toBe("");
  });
});
