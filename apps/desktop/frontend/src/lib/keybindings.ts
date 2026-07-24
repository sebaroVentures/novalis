// Device-local, user-configurable keyboard shortcuts. The keymap maps action
// ids → chord strings (e.g. "mod+shift+p"); `mod` is the platform primary
// modifier (⌘ on macOS, Ctrl elsewhere). Overrides persist in localStorage,
// mirroring the device-local pattern in lib/language.ts / lib/sidebarPrefs.ts.

import type { FeatureKey } from "./features";

export type ActionId =
  | "search"
  | "command-palette"
  | "settings"
  | "new-note"
  | "view-notes"
  | "view-today"
  | "view-tasks"
  | "view-calendar"
  | "view-graph"
  | "view-query"
  | "view-canvas"
  | "nav-back"
  | "nav-forward"
  | "cheatsheet"
  | "help"
  | "toggle-sidebar"
  | "close-tab"
  | "next-tab"
  | "prev-tab"
  | "split-right"
  | "split-down"
  | "focus-pane-left"
  | "focus-pane-right";

export const ACTION_IDS: ActionId[] = [
  "search",
  "command-palette",
  "settings",
  "new-note",
  "view-notes",
  "view-today",
  "view-tasks",
  "view-calendar",
  "view-graph",
  "view-query",
  "view-canvas",
  "nav-back",
  "nav-forward",
  "cheatsheet",
  "help",
  "toggle-sidebar",
  "close-tab",
  "next-tab",
  "prev-tab",
  "split-right",
  "split-down",
  "focus-pane-left",
  "focus-pane-right",
];

/** Actions owned by an optional feature (vault-synced Preferences.features).
 *  Call sites (the App keydown dispatcher, the cheatsheet, the keybindings
 *  panel) skip an action whose feature is off. The ids deliberately STAY in
 *  ActionId/ACTION_IDS/DEFAULT_KEYMAP so device-local chord overrides survive
 *  a feature being toggled off and on again. Type-only coupling to
 *  lib/features.ts — the effective check (featureOn/isFeatureOn) lives there. */
export const ACTION_FEATURE: Partial<Record<ActionId, FeatureKey>> = {
  "view-today": "todayView",
  "view-tasks": "tasks",
  "view-calendar": "calendar",
  "view-graph": "graphView",
  "view-query": "queryEngine",
  "view-canvas": "canvas",
};

/** A chord string like "mod+shift+p", "mod+,", "mod+[". */
export type Chord = string;

export const DEFAULT_KEYMAP: Record<ActionId, Chord> = {
  search: "mod+k",
  "command-palette": "mod+shift+p",
  settings: "mod+,",
  "new-note": "mod+n",
  "view-notes": "mod+1",
  "view-today": "mod+2",
  "view-tasks": "mod+3",
  "view-calendar": "mod+4",
  "view-graph": "mod+5",
  "view-query": "mod+6",
  "view-canvas": "mod+7",
  "nav-back": "mod+[",
  "nav-forward": "mod+]",
  cheatsheet: "mod+/",
  help: "mod+shift+/",
  "toggle-sidebar": "mod+\\",
  "close-tab": "mod+w",
  "next-tab": "mod+alt+]",
  "prev-tab": "mod+alt+[",
  "split-right": "mod+alt+\\",
  "split-down": "mod+alt+-",
  "focus-pane-left": "mod+alt+arrowleft",
  "focus-pane-right": "mod+alt+arrowright",
};

interface ParsedChord {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

export function isMac(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);
}

/** Coarse OS bucket for platform-specific labels (e.g. "Reveal in Finder" vs
 *  "Show in Explorer"). Built on the same `navigator` primitive as `isMac`. */
export function platformKind(): "mac" | "windows" | "linux" {
  if (isMac()) return "mac";
  const s = (typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent : "").toLowerCase();
  return /win/.test(s) ? "windows" : "linux";
}

export function parseChord(s: string): ParsedChord {
  const parts = s.toLowerCase().split("+");
  return {
    mod: parts.includes("mod"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    key: parts[parts.length - 1],
  };
}

export function chordFromEvent(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
}): ParsedChord {
  let key = e.key.toLowerCase();
  // On layouts where Shift+/ produces "?" (e.g. US), normalize back to "/" so
  // a stored "mod+shift+/" chord (the guide default) fires layout-independently.
  // No chord binds "?" directly, so this cannot shadow anything.
  if (key === "?") key = "/";
  return {
    mod: e.metaKey || e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    key,
  };
}

/** Canonical chord string for a parsed chord (modifier order: mod, alt, shift). */
export function normalizeChord(c: ParsedChord): Chord {
  const parts: string[] = [];
  if (c.mod) parts.push("mod");
  if (c.alt) parts.push("alt");
  if (c.shift) parts.push("shift");
  parts.push(c.key);
  return parts.join("+");
}

function chordsMatch(a: ParsedChord, b: ParsedChord): boolean {
  return a.mod === b.mod && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
}

/** The action bound to a keyboard event under `keymap`, or null. Ignores plain
 *  (modifier-less) keystrokes so it never swallows ordinary typing. An action
 *  the optional `available` predicate rejects (feature off) is skipped during
 *  matching rather than gated afterwards — otherwise it would silently shadow
 *  its chord from a visible action the user rebound to the same keys. */
export function actionForEvent(
  keymap: Record<ActionId, Chord>,
  e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string },
  available?: (action: ActionId) => boolean,
): ActionId | null {
  const ev = chordFromEvent(e);
  if (!ev.mod && !ev.alt) return null;
  for (const action of ACTION_IDS) {
    if (available && !available(action)) continue;
    if (chordsMatch(ev, parseChord(keymap[action]))) return action;
  }
  return null;
}

const KEY_GLYPHS: Record<string, string> = {
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
};

function prettyKey(key: string): string {
  const glyph = KEY_GLYPHS[key];
  if (glyph) return glyph;
  if (key.length === 1) return key.toUpperCase();
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Human-readable chord, e.g. "⌘⇧P" (macOS) or "Ctrl+Shift+P". */
export function formatChord(s: Chord): string {
  const c = parseChord(s);
  const mac = isMac();
  const parts: string[] = [];
  if (c.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (c.alt) parts.push(mac ? "⌥" : "Alt");
  if (c.shift) parts.push(mac ? "⇧" : "Shift");
  parts.push(prettyKey(c.key));
  return mac ? parts.join("") : parts.join("+");
}

const STORAGE_KEY = "novalis:device:keybindings";

function readOverrides(): Partial<Record<ActionId, Chord>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const overrides = raw ? (JSON.parse(raw) as Partial<Record<ActionId, Chord>>) : {};
    // Chords captured before chordFromEvent normalized "?" to "/" may be
    // stored with a "?" key (US layouts report Shift+/ as "?"). Normalize on
    // read so those overrides keep matching — events can no longer produce "?".
    for (const [action, chord] of Object.entries(overrides)) {
      if (chord?.endsWith("?")) {
        overrides[action as ActionId] = `${chord.slice(0, -1)}/`;
      }
    }
    return overrides;
  } catch {
    return {};
  }
}

/** The effective keymap: defaults with the user's device-local overrides applied. */
export function loadKeymap(): Record<ActionId, Chord> {
  return { ...DEFAULT_KEYMAP, ...readOverrides() };
}

/** Override (or, with `null`, reset to default) one action's chord. */
export function setKeybinding(action: ActionId, chord: Chord | null): void {
  try {
    const overrides = readOverrides();
    if (chord === null || chord === DEFAULT_KEYMAP[action]) delete overrides[action];
    else overrides[action] = chord;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* ignore */
  }
}

/** Clear all overrides (reset every shortcut to its default). */
export function resetKeymap(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
