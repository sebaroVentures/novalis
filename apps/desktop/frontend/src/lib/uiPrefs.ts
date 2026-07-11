// Device-local UI layout prefs (global, not per-vault): the left sidebar's
// collapsed state and width. Mirrors the device-pref pattern in
// lib/sidebarPrefs.ts (getRecentLimit) — stored in localStorage, clamped on read.

const COLLAPSED_KEY = "novalis:device:sidebarCollapsed";
const WIDTH_KEY = "novalis:device:sidebarWidth";
const ONBOARDING_KEY = "novalis:device:onboardingDone";

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
const DEFAULT_WIDTH = 256; // matches the previous fixed `w-64`

export function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    /* ignore quota errors — layout state is non-critical */
  }
}

const clampWidth = (n: number) =>
  Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(n)));

export function getSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? clampWidth(n) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export function saveSidebarWidth(n: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(clampWidth(n)));
  } catch {
    /* ignore */
  }
}

/** Whether the first-run onboarding has been seen/dismissed on this device. */
export function loadOnboardingDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_KEY) === "1";
  } catch {
    return true; // storage unavailable: don't nag with onboarding
  }
}

export function saveOnboardingDone(done: boolean): void {
  try {
    localStorage.setItem(ONBOARDING_KEY, done ? "1" : "0");
  } catch {
    /* ignore quota errors — onboarding state is non-critical */
  }
}
