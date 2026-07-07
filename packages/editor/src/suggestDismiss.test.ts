import { describe, expect, it } from "vitest";

import type { SuggestionMatch, Trigger } from "@tiptap/suggestion";

import { withDismissal } from "./suggestDismiss";

// The wrapper never touches the trigger itself — it only forwards it — so a
// dummy is enough for these tests.
const trigger = {} as Trigger;

function matchAt(from: number, text = "#tag"): SuggestionMatch {
  return { range: { from, to: from + text.length }, query: text.slice(1), text };
}

describe("withDismissal", () => {
  it("passes matches through before any dismissal", () => {
    const m = withDismissal(() => matchAt(5));
    expect(m.findSuggestionMatch(trigger)).toEqual(matchAt(5));
  });

  it("suppresses the dismissed token for as long as it persists", () => {
    const m = withDismissal(() => matchAt(5));
    m.dismiss({ from: 5 });
    expect(m.findSuggestionMatch(trigger)).toBeNull();
    // Typing on inside the same token (same start) stays suppressed.
    expect(m.findSuggestionMatch(trigger)).toBeNull();
  });

  it("clears the dismissal once the token breaks", () => {
    let current: SuggestionMatch = matchAt(5);
    const m = withDismissal(() => current);
    m.dismiss({ from: 5 });
    expect(m.findSuggestionMatch(trigger)).toBeNull();
    current = null; // cursor left / token deleted
    expect(m.findSuggestionMatch(trigger)).toBeNull();
    current = matchAt(5); // a fresh trigger at the same position
    expect(m.findSuggestionMatch(trigger)).toEqual(matchAt(5));
  });

  it("treats a token at a different position as a new session", () => {
    let current: SuggestionMatch = matchAt(5);
    const m = withDismissal(() => current);
    m.dismiss({ from: 5 });
    expect(m.findSuggestionMatch(trigger)).toBeNull();
    current = matchAt(9);
    expect(m.findSuggestionMatch(trigger)).toEqual(matchAt(9));
    // …and the old position is no longer suppressed either.
    current = matchAt(5);
    expect(m.findSuggestionMatch(trigger)).toEqual(matchAt(5));
  });
});
