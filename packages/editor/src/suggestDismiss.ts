// Escape handling for @tiptap/suggestion sessions. The Suggestion utility
// keeps a session active for as long as its matcher finds the trigger token
// before the cursor — merely hiding the popup on Escape leaves the session
// armed: a later Enter still runs the "dismissed" suggestion and the next
// keystroke redraws the popup. The plugin re-runs `findSuggestionMatch` on
// every transaction and drops to inactive (firing `onExit`, releasing key
// handling) exactly when the matcher returns null — so the supported way to
// terminate a session is to make the matcher stop matching it. This wrapper
// does that: after `dismiss(range)`, the token starting at `range.from` no
// longer matches. The dismissal ends when the token breaks (cursor left it /
// text deleted) or a different token starts, so a fresh trigger opens a fresh
// popup as usual.

import type { SuggestionMatch, Trigger } from "@tiptap/suggestion";

export interface DismissableMatcher {
  /** Drop-in `findSuggestionMatch` for the Suggestion plugin. */
  findSuggestionMatch: (trigger: Trigger) => SuggestionMatch;
  /** Mark the session whose match starts at `range.from` as dismissed. The
   *  caller must then dispatch a transaction (an empty one is enough) so the
   *  plugin re-evaluates and exits the session immediately. */
  dismiss: (range: { from: number }) => void;
}

export function withDismissal(find: (trigger: Trigger) => SuggestionMatch): DismissableMatcher {
  let dismissedFrom: number | null = null;
  return {
    findSuggestionMatch(trigger) {
      const match = find(trigger);
      if (!match) {
        dismissedFrom = null; // token gone — the next trigger is a new session
        return null;
      }
      if (dismissedFrom !== null) {
        if (match.range.from === dismissedFrom) return null; // still dismissed
        dismissedFrom = null; // a different token — new session
      }
      return match;
    },
    dismiss(range) {
      dismissedFrom = range.from;
    },
  };
}
