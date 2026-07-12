// Device-local activity-rail layout: which top-level views appear in the left
// activity rail and in what order. Global UI chrome (not per-vault), like the
// sidebar collapse/width in lib/uiPrefs.ts — stored in localStorage. A fresh
// install (no stored config) renders exactly today's rail: all five views in
// canonical order, all enabled.

import { create } from "zustand";

import type { MainView } from "../components/Sidebar";

export interface RailItem {
  view: MainView;
  enabled: boolean;
}
export type RailConfig = RailItem[];

const KEY = "novalis:device:railConfig";

/** Canonical view order (mirrors ActivityRail's VIEW_ITEMS). The default config
 *  is these five, all enabled — so untouched installs see no change. */
const DEFAULT_ORDER: MainView[] = [
  "notes",
  "today",
  "tasks",
  "calendar",
  "graph",
  "query",
  "canvas",
];
const KNOWN = new Set<MainView>(DEFAULT_ORDER);

export function defaultRailConfig(): RailConfig {
  return DEFAULT_ORDER.map((view) => ({ view, enabled: true }));
}

/** Guarantee at least one view stays enabled — an all-off rail would be a dead
 *  end. If a config would disable everything, re-enable the first item. */
function ensureOneEnabled(cfg: RailConfig): RailConfig {
  if (cfg.some((i) => i.enabled)) return cfg;
  return cfg.map((i, idx) => (idx === 0 ? { ...i, enabled: true } : i));
}

/** Reconcile a possibly-stale stored config against the known view set so app
 *  upgrades never lose or break items: keep the stored order for known views,
 *  drop unknown/duplicate ones, and append any missing (newly added) views as
 *  enabled at the end. Also enforces the at-least-one-enabled guard. */
function reconcile(stored: unknown): RailConfig {
  if (!Array.isArray(stored)) return defaultRailConfig();
  const seen = new Set<MainView>();
  const out: RailConfig = [];
  for (const item of stored) {
    const view = (item as Partial<RailItem>)?.view;
    if (!view || !KNOWN.has(view) || seen.has(view)) continue;
    seen.add(view);
    // Missing/invalid `enabled` defaults to on (forward-compat with older data).
    out.push({ view, enabled: (item as RailItem).enabled !== false });
  }
  for (const view of DEFAULT_ORDER) {
    if (!seen.has(view)) out.push({ view, enabled: true });
  }
  return ensureOneEnabled(out);
}

export function loadRailConfig(): RailConfig {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? reconcile(JSON.parse(raw)) : defaultRailConfig();
  } catch {
    return defaultRailConfig();
  }
}

export function saveRailConfig(cfg: RailConfig): RailConfig {
  const safe = ensureOneEnabled(cfg);
  try {
    localStorage.setItem(KEY, JSON.stringify(safe));
  } catch {
    /* ignore quota errors — layout state is non-critical */
  }
  return safe;
}

/** The ordered list of views the rail should render (enabled only). */
export function enabledRailViews(cfg: RailConfig): MainView[] {
  return cfg.filter((i) => i.enabled).map((i) => i.view);
}

// ── Reactive store ──────────────────────────────────────────────────────────
// A tiny zustand store so the rail and the settings panel share one source of
// truth: editing the config in Settings re-renders the rail live. Mirrors the
// keymapStore pattern (store wraps the pure load/save helpers).
interface RailConfigStore {
  config: RailConfig;
  /** Persist a new config (enforcing the guard) and re-render subscribers. */
  setConfig: (cfg: RailConfig) => void;
  /** Toggle one view on/off. */
  toggle: (view: MainView) => void;
  /** Move a view one slot up (-1) or down (+1) in rail order. */
  move: (view: MainView, dir: -1 | 1) => void;
}

export const useRailConfig = create<RailConfigStore>((set, get) => ({
  config: loadRailConfig(),
  setConfig: (cfg) => set({ config: saveRailConfig(cfg) }),
  toggle: (view) =>
    get().setConfig(
      get().config.map((i) => (i.view === view ? { ...i, enabled: !i.enabled } : i)),
    ),
  move: (view, dir) => {
    const cfg = get().config;
    const i = cfg.findIndex((x) => x.view === view);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cfg.length) return;
    const next = cfg.slice();
    [next[i], next[j]] = [next[j], next[i]];
    get().setConfig(next);
  },
}));
