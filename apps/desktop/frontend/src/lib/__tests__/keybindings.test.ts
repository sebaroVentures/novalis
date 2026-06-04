import { describe, expect, it } from "vitest";

import {
  actionForEvent,
  chordFromEvent,
  DEFAULT_KEYMAP,
  normalizeChord,
  parseChord,
} from "../keybindings";

const ev = (over: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string }>) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  key: "a",
  ...over,
});

describe("parseChord / normalizeChord", () => {
  it("round-trips a chord", () => {
    expect(normalizeChord(parseChord("mod+shift+p"))).toBe("mod+shift+p");
  });

  it("orders modifiers canonically", () => {
    expect(normalizeChord(parseChord("shift+mod+k"))).toBe("mod+shift+k");
  });
});

describe("chordFromEvent", () => {
  it("treats meta or ctrl as the platform 'mod'", () => {
    expect(chordFromEvent(ev({ metaKey: true, key: "K" }))).toEqual({
      mod: true,
      shift: false,
      alt: false,
      key: "k",
    });
    expect(chordFromEvent(ev({ ctrlKey: true, key: "k" })).mod).toBe(true);
  });
});

describe("actionForEvent", () => {
  it("matches a bound chord", () => {
    expect(actionForEvent(DEFAULT_KEYMAP, ev({ metaKey: true, key: "k" }))).toBe("search");
    expect(actionForEvent(DEFAULT_KEYMAP, ev({ ctrlKey: true, shiftKey: true, key: "P" }))).toBe(
      "command-palette",
    );
  });

  it("ignores modifier-less keystrokes (never swallows typing)", () => {
    expect(actionForEvent(DEFAULT_KEYMAP, ev({ key: "k" }))).toBeNull();
  });

  it("returns null for an unbound chord", () => {
    expect(actionForEvent(DEFAULT_KEYMAP, ev({ metaKey: true, key: "j" }))).toBeNull();
  });
});
