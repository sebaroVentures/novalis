import { describe, expect, it } from "vitest";

import {
  appendUnderActions,
  buildTaskLine,
  coerceTask,
  extractJsonArray,
  frontmatterOf,
  normalizePriority,
  parseExtractedTasks,
} from "../taskExtract";

describe("extractJsonArray", () => {
  it("parses a bare array", () => {
    expect(extractJsonArray('[{"text":"a"}]')).toEqual([{ text: "a" }]);
  });

  it("tolerates a ```json code fence and surrounding prose", () => {
    const raw = 'Here you go:\n```json\n[{"text":"a"}]\n```\nHope that helps!';
    expect(extractJsonArray(raw)).toEqual([{ text: "a" }]);
  });

  it("returns null for non-JSON / non-array / malformed output", () => {
    expect(extractJsonArray("sorry, I can't help with that")).toBeNull();
    expect(extractJsonArray('{"text":"a"}')).toBeNull(); // object, not array
    expect(extractJsonArray("[not valid json")).toBeNull();
  });
});

describe("coerceTask", () => {
  it("keeps valid fields", () => {
    expect(
      coerceTask({
        text: "  Do it  ",
        due: "2026-07-15",
        start: "2026-07-10",
        project: "launch",
        priority: "high",
      }),
    ).toEqual({
      text: "Do it",
      due: "2026-07-15",
      start: "2026-07-10",
      project: "launch",
      priority: "high",
    });
  });

  it("drops invalid optional fields but keeps the task", () => {
    expect(
      coerceTask({
        text: "Follow up",
        due: "2026/07/15",
        start: "tomorrow",
        project: "Bad Slug",
        priority: "epic",
      }),
    ).toEqual({ text: "Follow up", due: undefined, start: undefined, project: undefined, priority: undefined });
  });

  it("normalizes the 'med' priority shorthand", () => {
    expect(normalizePriority("med")).toBe("medium");
    expect(coerceTask({ text: "x", priority: "MED" })?.priority).toBe("medium");
  });

  it("rejects an item without usable text", () => {
    expect(coerceTask({ text: "   " })).toBeNull();
    expect(coerceTask({ due: "2026-07-15" })).toBeNull();
    expect(coerceTask("nope")).toBeNull();
  });
});

describe("buildTaskLine", () => {
  it("emits fields in the canonical order (matches the Rust helper)", () => {
    expect(
      buildTaskLine({
        text: "Email the vendor",
        due: "2026-07-15",
        start: "2026-07-10",
        project: "launch",
        priority: "high",
      }),
    ).toBe(
      "- [ ] Email the vendor @priority(high) @start(2026-07-10) @due(2026-07-15) @project(launch)",
    );
  });

  it("omits absent fields", () => {
    expect(buildTaskLine({ text: "Just text" })).toBe("- [ ] Just text");
    expect(buildTaskLine({ text: "Due only", due: "2026-07-15" })).toBe(
      "- [ ] Due only @due(2026-07-15)",
    );
  });
});

describe("parseExtractedTasks", () => {
  it("dedupes against existing note task lines and within the batch", () => {
    const body = "## Notes\n\n- [x] Email the vendor @due(2026-07-01)\n- [ ] Book the room\n";
    const raw = JSON.stringify([
      { text: "Email the vendor" }, // already in the note (annotations ignored)
      { text: "Draft the agenda" },
      { text: "draft the AGENDA" }, // dupe within the batch (case-insensitive)
    ]);
    const out = parseExtractedTasks(raw, body);
    expect(out.map((t) => t.text)).toEqual(["Draft the agenda"]);
  });

  it("returns an empty list on malformed output (never garbage)", () => {
    expect(parseExtractedTasks("the model refused", "")).toEqual([]);
    expect(parseExtractedTasks('[{"nope":1},"junk",42]', "")).toEqual([]);
  });
});

describe("appendUnderActions", () => {
  it("creates an ## Actions section at the end when absent", () => {
    expect(appendUnderActions("# Meeting\n\nSome notes.", ["- [ ] A", "- [ ] B"])).toBe(
      "# Meeting\n\nSome notes.\n\n## Actions\n\n- [ ] A\n- [ ] B\n",
    );
  });

  it("appends into an existing ## Actions section (after its last task)", () => {
    const body = "## Actions\n\n- [ ] Existing\n\n## Other\n\ntail\n";
    expect(appendUnderActions(body, ["- [ ] New"])).toBe(
      "## Actions\n\n- [ ] Existing\n- [ ] New\n\n## Other\n\ntail\n",
    );
  });

  it("handles an empty body", () => {
    expect(appendUnderActions("", ["- [ ] A"])).toBe("## Actions\n\n- [ ] A\n");
  });
});

describe("frontmatterOf", () => {
  it("extracts the leading YAML block", () => {
    expect(frontmatterOf("---\ntitle: X\n---\nbody\n")).toBe("---\ntitle: X\n---\n");
  });

  it("returns empty string when there is no frontmatter", () => {
    expect(frontmatterOf("just a body\n")).toBe("");
  });
});
