// Effective feature availability, derived from the vault-synced
// Preferences.features block (see FeaturePrefs in preferences.rs).
//
// The AI family is nested: `ai` is the master switch and a sub-feature is
// active only when BOTH `ai` and its own flag are true. Every surface that
// shows or hides on a feature must go through featureOn/useFeature so that
// nesting rule lives in exactly one place. Ambient AI keeps its canonical
// gate in EditorPrefs.ambientAi (ANDed with the `ai` master at its call
// site) and git sync keeps GitPrefs.enabled — neither is duplicated here.

import type { FeaturePrefs } from "../ipc/api";
import { resolveFeaturePrefs, useSettings } from "../stores/settingsStore";

export type FeatureKey = keyof Required<FeaturePrefs>;

/** The AI sub-features gated by the `ai` master switch. */
const AI_SUBS: ReadonlySet<FeatureKey> = new Set([
  "aiMetaSuggestions",
  "aiTemplates",
  "taskExtract",
  "weeklyReview",
  "vaultChat",
  "relatedNotes",
  "entityGraph",
]);

/** Effective state of one feature given a raw (resolved) flag block. */
export function featureOn(
  features: FeaturePrefs | undefined,
  key: FeatureKey,
): boolean {
  const f = resolveFeaturePrefs(features);
  if (AI_SUBS.has(key)) return f.ai && f[key];
  return f[key];
}

/**
 * Reactive effective flag for components. Before the per-vault prefs load
 * resolves, this reports the serde defaults — the same values a vault
 * without a features block gets, so there is no on→off flash for default-on
 * features.
 */
export function useFeature(key: FeatureKey): boolean {
  return useSettings((s) => featureOn(s.prefs?.features, key));
}

/** Imperative read for non-reactive call sites (keydown handlers, stores). */
export function isFeatureOn(key: FeatureKey): boolean {
  return featureOn(useSettings.getState().prefs?.features, key);
}
