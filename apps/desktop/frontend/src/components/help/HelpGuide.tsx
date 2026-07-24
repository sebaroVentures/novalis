import { useEffect, useRef, useState } from "react";

import { Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useHelpLoaded } from "../../help/loadHelp";
import {
  GROUP_LABEL_KEYS,
  HELP_GROUPS,
  HELP_TOPIC_BY_ID,
  HELP_TOPICS,
  type HelpTopic,
  type HelpTopicId,
} from "../../help/registry";
import { api, type FeaturePrefs, type Preferences } from "../../ipc/api";
import { featureOn, type FeatureKey } from "../../lib/features";
import { fuzzyRank } from "../../lib/fuzzy";
import { formatChord } from "../../lib/keybindings";
import { useCanvas } from "../../stores/canvasStore";
import { useKeymap } from "../../stores/keymapStore";
import { resolveGitPrefs, useSettings } from "../../stores/settingsStore";
import { useUi } from "../../stores/uiStore";
import { useVault } from "../../stores/vaultStore";
import { useCategoryLabels } from "../settings/SettingsNav";
import { Modal } from "../ui/Modal";

/** Registry-driven i18n keys (titleKey / keyBase / descKey are plain strings)
 *  can't satisfy the literal-union typed `t` — this is the one deliberately
 *  untyped view of it for exactly those keys. Their REAL gate is
 *  src/help/__tests__/registry.test.ts, which resolves every key against the
 *  en catalogs. */
type DynamicT = (key: string) => string;

/** Mirrors AI_SUBS in lib/features.ts (not exported there): an AI sub-feature
 *  is only effective with the `ai` master on (featureOn's nesting), so
 *  enabling one from the guide must turn the master on too. */
const AI_SUBS: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
  "aiMetaSuggestions",
  "aiTemplates",
  "taskExtract",
  "weeklyReview",
  "vaultChat",
  "relatedNotes",
  "entityGraph",
]);

/** Effective on/off of a topic's gate: Preferences.features via featureOn
 *  (which owns the AI master&&sub nesting) — except the two out-of-band gates,
 *  whose canonical switches live in EditorPrefs.ambientAi (ANDed with the `ai`
 *  master) and GitPrefs.enabled. Basics topics have no gate: always on. */
function topicGateOn(prefs: Preferences | null, topic: HelpTopic): boolean {
  if (topic.customGate === "ambientAi") {
    return featureOn(prefs?.features, "ai") && (prefs?.editor?.ambientAi ?? false);
  }
  if (topic.customGate === "gitSync") return resolveGitPrefs(prefs?.git).enabled;
  if (topic.feature) return featureOn(prefs?.features, topic.feature);
  return true;
}

/** The Feature Guide overlay: a searchable two-pane index of every feature
 *  (help/registry.ts) with per-topic prose, syntax tables, a live shortcut,
 *  and enable / open-settings / demo-note actions. Opened via
 *  useUi.openHelp(topic?); "index" (the default) lands on the first topic. */
export function HelpGuide() {
  const { t, i18n } = useTranslation(["help", "settings", "common"]);
  const td = t as unknown as DynamicT;
  const helpLoaded = useHelpLoaded();
  const helpTopic = useUi((s) => s.helpTopic);
  const closeHelp = useUi((s) => s.closeHelp);
  const keymap = useKeymap((s) => s.keymap);
  const prefs = useSettings((s) => s.prefs);
  const categoryLabels = useCategoryLabels();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Result line of the last "Create example note" click (reset on topic switch).
  const [demoResult, setDemoResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);

  // "index" lands on the first topic — the left pane always mirrors the
  // selection, so there is no separate empty/intro state to style. (Topic ids
  // are typed at the store now, so only "index"/null reach the fallback.)
  const selected =
    (helpTopic && helpTopic !== "index" ? HELP_TOPIC_BY_ID.get(helpTopic) : undefined) ??
    HELP_TOPICS[0];

  useEffect(() => {
    setDemoResult(null);
    setDemoBusy(false);
  }, [selected.id]);

  // The help catalogs load lazily (loadHelp.ts): until they're registered,
  // every help-ns t() would render raw keys — hold the whole body behind a
  // spinner instead. The Modal shell still mounts so Esc closes.
  if (!helpLoaded) {
    return (
      <Modal
        label={t("common:helpGuide")}
        onClose={closeHelp}
        overlayClassName="z-50 items-center justify-center p-4"
        panelClassName="flex h-[80vh] max-h-[640px] w-full max-w-3xl items-center justify-center rounded-2xl border border-border bg-surface shadow-2xl"
      >
        <Loader2 size={20} className="animate-spin text-accent" />
      </Modal>
    );
  }

  const gateOn = (topic: HelpTopic) => topicGateOn(prefs, topic);
  const select = (id: HelpTopicId) => useUi.getState().openHelp(id);

  // Fuzzy search over title + "what" prose; with a query the list is a flat
  // ranked result set (group headings only make sense in registry order).
  const q = query.trim();
  const ranked =
    q === ""
      ? null
      : fuzzyRank(
          [...HELP_TOPICS],
          q,
          (topic) => `${td(topic.titleKey)} ${td(`help:${topic.keyBase}.what`)}`,
        );

  const topicRow = (topic: HelpTopic) => {
    const Icon = topic.icon;
    const off = !gateOn(topic);
    const active = topic.id === selected.id;
    return (
      <li key={topic.id}>
        <button
          type="button"
          onClick={() => select(topic.id)}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
            active ? "bg-active text-fg" : "text-fg-muted hover:bg-hover hover:text-fg"
          } ${off ? "opacity-60" : ""}`}
        >
          <Icon size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{td(topic.titleKey)}</span>
          {off && (
            <span className="shrink-0 rounded bg-surface-2 px-1 py-0.5 text-[10px] uppercase tracking-wide text-fg-faint ring-1 ring-border">
              {t("help:guide.offBadge")}
            </span>
          )}
        </button>
      </li>
    );
  };

  // ── Selected-topic derivations ─────────────────────────────────────────────
  const kb = selected.keyBase;
  const SelectedIcon = selected.icon;
  const selectedOff = !gateOn(selected);
  // Optional prose: probe instead of rendering raw keys. `.cost` exists exactly
  // for the topics that declare costMb/tokenCost (registry.test.ts keeps the
  // registry and catalogs in sync), so probing covers both callout triggers.
  const setupText = i18n.exists(`help:${kb}.setup`) ? td(`help:${kb}.setup`) : null;
  const costText = i18n.exists(`help:${kb}.cost`) ? td(`help:${kb}.cost`) : null;
  const openSettingsLabel = selected.settingsCategory
    ? `${t("help:guide.openSettings")} › ${categoryLabels[selected.settingsCategory]}`
    : null;

  const enable = () => {
    if (!selected.feature) return;
    // One patch: the sub flag plus (for AI subs) the `ai` master, or featureOn
    // would keep the feature effectively off. Custom-gate topics never get this
    // button — their switch lives in Settings (the openSettings link).
    const patch: Partial<FeaturePrefs> = { [selected.feature]: true };
    if (AI_SUBS.has(selected.feature)) patch.ai = true;
    useSettings.getState().setFeatures(patch);
  };

  const openSettingsAt = () => {
    const category = selected.settingsCategory;
    if (!category) return;
    // No stacked modals: close the guide first; App consumes the one-shot
    // request and opens the Settings dialog at the category.
    closeHelp();
    useUi.getState().requestSettingsCategory(category);
  };

  const insertExample = async () => {
    if (!selected.demoTopic) return;
    setDemoBusy(true);
    try {
      const path = await api.createDemoNote(selected.demoTopic);
      // The success copy points at the file tree — refresh it so the note is
      // really there (same as the palette's open-today's-note flow).
      await useVault.getState().refreshTree();
      setDemoResult({ ok: true, text: t("help:guide.exampleCreated") });
      // A .canvas demo can't open as a note tab — open the board directly
      // (openCanvas also switches the view; a plain setView would be a no-op
      // when the user is already in the canvas view, and the gallery only
      // refreshes on mount); .md demos open as a foreground tab.
      if (path.endsWith(".canvas")) useCanvas.getState().openCanvas(path);
      else useUi.getState().openInWorkspace(path);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setDemoResult({ ok: false, text: `${t("help:guide.exampleFailed")} ${message}` });
    } finally {
      setDemoBusy(false);
    }
  };

  return (
    <Modal
      label={t("common:helpGuide")}
      onClose={closeHelp}
      initialFocusRef={searchRef}
      overlayClassName="z-50 items-center justify-center p-4"
      panelClassName="flex h-[80vh] max-h-[640px] w-full max-w-3xl overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
    >
      {/* Left: search + grouped topic index. */}
      <div className="flex w-60 shrink-0 flex-col border-r border-border bg-app/40">
        <div className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-fg-faint">
          {t("help:guide.title")}
        </div>
        <div className="px-2 pb-1">
          {/* autoFocus (not just initialFocusRef): on the very first open the
              Modal mounts in the loading state above, and its focus effect is
              mount-only — the input must claim focus itself when it appears. */}
          <input
            ref={searchRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("help:guide.searchPlaceholder")}
            className="w-full rounded-md bg-surface-2 px-2.5 py-1.5 text-sm text-fg outline-none ring-1 ring-border placeholder:text-fg-faint focus:ring-accent"
          />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {ranked === null ? (
            HELP_GROUPS.map((g) => (
              <li key={g}>
                <div className="px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-fg-faint">
                  {td(GROUP_LABEL_KEYS[g])}
                </div>
                <ul>{HELP_TOPICS.filter((topic) => topic.group === g).map(topicRow)}</ul>
              </li>
            ))
          ) : ranked.length === 0 ? (
            <li className="px-2 py-3 text-sm text-fg-faint">{t("help:guide.noResults")}</li>
          ) : (
            ranked.map(topicRow)
          )}
        </ul>
      </div>

      {/* Right: the selected topic page. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2.5 border-b border-border px-5 py-3">
          <SelectedIcon size={18} className="shrink-0 text-accent" />
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
            {td(selected.titleKey)}
          </h2>
          {selected.chord && (
            <kbd className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-fg ring-1 ring-border">
              {formatChord(keymap[selected.chord])}
            </kbd>
          )}
          <button
            onClick={closeHelp}
            aria-label={t("help:guide.close")}
            className="shrink-0 rounded-md p-1 text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-w-0 flex-1 space-y-4 overflow-y-auto p-5">
          <p className="text-sm leading-relaxed text-fg">{td(`help:${kb}.what`)}</p>
          <p className="text-sm leading-relaxed text-fg-muted">{td(`help:${kb}.where`)}</p>
          {selected.syntax && (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <tbody>
                  {selected.syntax.map((row) => (
                    <tr key={row.descKey} className="border-b border-border last:border-b-0">
                      <td className="whitespace-nowrap px-3 py-1.5 align-top font-mono text-xs text-fg">
                        {row.code}
                      </td>
                      <td className="px-3 py-1.5 text-fg-muted">{td(`help:${row.descKey}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {setupText && <p className="text-sm leading-relaxed text-accent">{setupText}</p>}
          {costText && (
            <div className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs leading-relaxed text-fg-muted">
              {costText}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {selectedOff && selected.feature && (
              <button
                type="button"
                onClick={enable}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90"
              >
                {t("help:guide.enable")}
              </button>
            )}
            {openSettingsLabel && (
              <button
                type="button"
                onClick={openSettingsAt}
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-hover"
              >
                {openSettingsLabel}
              </button>
            )}
            {selected.demoTopic && !selectedOff && (
              <button
                type="button"
                onClick={() => void insertExample()}
                disabled={demoBusy}
                className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {demoBusy && <Loader2 size={13} className="animate-spin" />}
                {t("help:guide.insertExample")}
              </button>
            )}
          </div>
          {demoResult && (
            <p
              className={`text-xs ${demoResult.ok ? "text-fg-subtle" : "text-danger"}`}
              role={demoResult.ok ? undefined : "alert"}
            >
              {demoResult.text}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
