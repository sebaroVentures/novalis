// The Feature Guide's content backbone: one typed registry entry per feature
// flag (all 32 FeaturePrefs keys), per out-of-band gate (ambient AI, git
// sync), and per always-on basic (wikilinks, search, …). The overlay renders
// everything from this data — copy lives in the lazily-loaded `help` i18n
// namespace (see loadHelp.ts), keyed by each topic's `keyBase`.
//
// Display names are NOT duplicated here or in help.json: gated topics reuse
// the exact settings:features.*.label strings (so the guide and Settings ›
// Features always agree on a feature's name), via the fully-qualified
// `titleKey`. Only core "basics" topics carry their own help:topics.<id>.title.
// Group headings work the same way: every group except `basics` reuses the
// settings:features.section* heading (see GROUP_LABEL_KEYS below).
//
// i18next-parser only scans static t() literals; every help key below resolves
// at runtime via t(`${topic.keyBase}.…`), so enumerate them all to keep them
// (precedent: Onboarding.tsx). src/help/__tests__/registry.test.ts is the REAL
// gate that these dynamic keys and the catalogs stay in sync.
// t("help:guide.close") t("help:guide.enable") t("help:guide.exampleCreated")
// t("help:guide.exampleFailed") t("help:guide.groups.basics") t("help:guide.insertExample")
// t("help:guide.learnMore") t("help:guide.noResults") t("help:guide.offBadge")
// t("help:guide.openSettings") t("help:guide.searchPlaceholder") t("help:guide.title")
// t("help:topics.ai.setup") t("help:topics.ai.what") t("help:topics.ai.where")
// t("help:topics.aiMetaSuggestions.what") t("help:topics.aiMetaSuggestions.where")
// t("help:topics.aiTemplates.what") t("help:topics.aiTemplates.where")
// t("help:topics.ambientAi.cost") t("help:topics.ambientAi.setup") t("help:topics.ambientAi.what")
// t("help:topics.ambientAi.where")
// t("help:topics.backlinks.what") t("help:topics.backlinks.where")
// t("help:topics.blockRefs.setup") t("help:topics.blockRefs.syntax.marker")
// t("help:topics.blockRefs.syntax.reference") t("help:topics.blockRefs.what")
// t("help:topics.blockRefs.where")
// t("help:topics.calendar.what") t("help:topics.calendar.where")
// t("help:topics.calendarSync.setup") t("help:topics.calendarSync.what")
// t("help:topics.calendarSync.where")
// t("help:topics.callouts.syntax.basic") t("help:topics.callouts.syntax.titled")
// t("help:topics.callouts.what") t("help:topics.callouts.where")
// t("help:topics.canvas.what") t("help:topics.canvas.where")
// t("help:topics.cheatsheet.title") t("help:topics.cheatsheet.what")
// t("help:topics.cheatsheet.where")
// t("help:topics.codeHighlight.syntax.fence") t("help:topics.codeHighlight.what")
// t("help:topics.codeHighlight.where")
// t("help:topics.commandPalette.title") t("help:topics.commandPalette.what")
// t("help:topics.commandPalette.where")
// t("help:topics.dailyNotes.what") t("help:topics.dailyNotes.where")
// t("help:topics.editorBasics.syntax.slash") t("help:topics.editorBasics.syntax.tag")
// t("help:topics.editorBasics.title") t("help:topics.editorBasics.what")
// t("help:topics.editorBasics.where")
// t("help:topics.entityGraph.cost") t("help:topics.entityGraph.what")
// t("help:topics.entityGraph.where")
// t("help:topics.gitSync.setup") t("help:topics.gitSync.what") t("help:topics.gitSync.where")
// t("help:topics.graphView.what") t("help:topics.graphView.where")
// t("help:topics.icsSubscriptions.setup") t("help:topics.icsSubscriptions.what")
// t("help:topics.icsSubscriptions.where")
// t("help:topics.math.syntax.block") t("help:topics.math.syntax.inline")
// t("help:topics.math.what") t("help:topics.math.where")
// t("help:topics.mermaid.syntax.fence") t("help:topics.mermaid.what")
// t("help:topics.mermaid.where")
// t("help:topics.outline.what") t("help:topics.outline.where")
// t("help:topics.p2pSync.setup") t("help:topics.p2pSync.what") t("help:topics.p2pSync.where")
// t("help:topics.pdfAnnotate.what") t("help:topics.pdfAnnotate.where")
// t("help:topics.plugins.what") t("help:topics.plugins.where")
// t("help:topics.properties.syntax.checkbox") t("help:topics.properties.syntax.frontmatter")
// t("help:topics.properties.syntax.list") t("help:topics.properties.syntax.number")
// t("help:topics.properties.syntax.relation") t("help:topics.properties.syntax.text")
// t("help:topics.properties.what") t("help:topics.properties.where")
// t("help:topics.queryEngine.syntax.alias") t("help:topics.queryEngine.syntax.folder")
// t("help:topics.queryEngine.syntax.fulltext") t("help:topics.queryEngine.syntax.hasFacet")
// t("help:topics.queryEngine.syntax.hasProp") t("help:topics.queryEngine.syntax.negate")
// t("help:topics.queryEngine.syntax.path") t("help:topics.queryEngine.syntax.propCompare")
// t("help:topics.queryEngine.syntax.propEquals") t("help:topics.queryEngine.syntax.propNotEquals")
// t("help:topics.queryEngine.syntax.relation") t("help:topics.queryEngine.syntax.sort")
// t("help:topics.queryEngine.syntax.sortSimilarity") t("help:topics.queryEngine.syntax.tag")
// t("help:topics.queryEngine.syntax.taskDone") t("help:topics.queryEngine.syntax.taskDue")
// t("help:topics.queryEngine.syntax.taskPriority") t("help:topics.queryEngine.syntax.taskStatus")
// t("help:topics.queryEngine.syntax.title") t("help:topics.queryEngine.syntax.view")
// t("help:topics.queryEngine.what") t("help:topics.queryEngine.where")
// t("help:topics.readingMode.title") t("help:topics.readingMode.what")
// t("help:topics.readingMode.where")
// t("help:topics.relatedNotes.cost") t("help:topics.relatedNotes.setup")
// t("help:topics.relatedNotes.what") t("help:topics.relatedNotes.where")
// t("help:topics.reminders.what") t("help:topics.reminders.where")
// t("help:topics.search.title") t("help:topics.search.what") t("help:topics.search.where")
// t("help:topics.tagAutocomplete.what") t("help:topics.tagAutocomplete.where")
// t("help:topics.taskExtract.what") t("help:topics.taskExtract.where")
// t("help:topics.taskTokens.syntax.checkbox") t("help:topics.taskTokens.syntax.due")
// t("help:topics.taskTokens.syntax.epic") t("help:topics.taskTokens.syntax.nlDates")
// t("help:topics.taskTokens.syntax.priority") t("help:topics.taskTokens.syntax.project")
// t("help:topics.taskTokens.syntax.remind") t("help:topics.taskTokens.syntax.repeat")
// t("help:topics.taskTokens.syntax.start") t("help:topics.taskTokens.syntax.status")
// t("help:topics.taskTokens.syntax.tag") t("help:topics.taskTokens.title")
// t("help:topics.taskTokens.what") t("help:topics.taskTokens.where")
// t("help:topics.tasks.what") t("help:topics.tasks.where")
// t("help:topics.todayView.what") t("help:topics.todayView.where")
// t("help:topics.transclusion.syntax.note") t("help:topics.transclusion.syntax.section")
// t("help:topics.transclusion.what") t("help:topics.transclusion.where")
// t("help:topics.vaultChat.cost") t("help:topics.vaultChat.setup") t("help:topics.vaultChat.what")
// t("help:topics.vaultChat.where")
// t("help:topics.versionHistory.title") t("help:topics.versionHistory.what")
// t("help:topics.versionHistory.where")
// t("help:topics.voice.cost") t("help:topics.voice.what") t("help:topics.voice.where")
// t("help:topics.weeklyReview.what") t("help:topics.weeklyReview.where")
// t("help:topics.wikilinks.syntax.alias") t("help:topics.wikilinks.syntax.heading")
// t("help:topics.wikilinks.syntax.link") t("help:topics.wikilinks.title")
// t("help:topics.wikilinks.what") t("help:topics.wikilinks.where")

import {
  Bell,
  BookOpen,
  Braces,
  Brackets,
  Calendar,
  CalendarCheck,
  CalendarDays,
  Code,
  Command,
  FileText,
  GitBranch,
  Hash,
  Highlighter,
  History,
  Info,
  Keyboard,
  Layers,
  Link2,
  List,
  ListChecks,
  ListTodo,
  ListTree,
  MessageSquare,
  Mic,
  Network,
  NotebookPen,
  Orbit,
  PenLine,
  Puzzle,
  RefreshCw,
  Rss,
  Search,
  Shapes,
  Sigma,
  Sparkles,
  SquareCheckBig,
  Sun,
  Table2,
  Waypoints,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import type { FeatureKey } from "../lib/features";
import type { ActionId } from "../lib/keybindings";
import type { CategoryId } from "../components/settings/SettingsNav";

/** The guide's sections, mirroring Settings › Features (FeaturesPanel.tsx)
 *  plus a leading `basics` group for the always-on core. */
export type HelpGroup =
  | "basics"
  | "ai"
  | "editor"
  | "workspace"
  | "graph"
  | "power"
  | "sync"
  | "media";

/** Group display order (basics first, then the FeaturesPanel section order). */
export const HELP_GROUPS: readonly HelpGroup[] = [
  "basics",
  "ai",
  "editor",
  "workspace",
  "graph",
  "power",
  "sync",
  "media",
];

/** Fully-qualified (ns-prefixed) i18n key of each group heading. Every group
 *  except `basics` reuses the settings:features.section* heading so the guide
 *  and Settings › Features can never drift apart. */
export const GROUP_LABEL_KEYS: Record<HelpGroup, string> = {
  basics: "help:guide.groups.basics",
  ai: "settings:features.sectionAi",
  editor: "settings:features.sectionEditor",
  workspace: "settings:features.sectionWorkspace",
  graph: "settings:features.sectionGraph",
  power: "settings:features.sectionPower",
  sync: "settings:features.sectionSync",
  media: "settings:features.sectionMedia",
};

export type HelpTopicId =
  // Core, always-on basics.
  | "wikilinks"
  | "search"
  | "commandPalette"
  | "editorBasics"
  | "taskTokens"
  | "cheatsheet"
  | "readingMode"
  | "versionHistory"
  // The 32 FeaturePrefs flags (wire names from ipc/bindings.ts).
  | FeatureKey
  // Out-of-band gates: EditorPrefs.ambientAi and GitPrefs.enabled.
  | "ambientAi"
  | "gitSync";

export interface HelpSyntaxRow {
  /** UNTRANSLATED literal to render verbatim in a code font. */
  code: string;
  /** Full key into the `help` namespace: `topics.<id>.syntax.<slug>`. */
  descKey: string;
}

export interface HelpTopic {
  id: HelpTopicId;
  group: HelpGroup;
  /**
   * The Preferences.features flag gating this topic — check it with
   * featureOn/useFeature (which owns the AI master&&sub nesting). Absent on
   * basics topics and on the two out-of-band gates below.
   */
  feature?: FeatureKey;
  /**
   * Gates that live outside Preferences.features: `ambientAi` is
   * EditorPrefs.ambientAi ANDed with the `ai` master, `gitSync` is
   * GitPrefs.enabled. The overlay must not featureOn() these; the topic's
   * `setup` copy explains where the real switch lives.
   */
  customGate?: "ambientAi" | "gitSync";
  icon: LucideIcon;
  /** Keyboard shortcut — render live via formatChord(keymap[chord]). */
  chord?: ActionId;
  /** Settings category where this topic's setup lives (SettingsNav.tsx). */
  settingsCategory?: CategoryId;
  syntax?: HelpSyntaxRow[];
  /** One-time model download, MB (figures match settings/ai catalogs). */
  costMb?: 130 | 142;
  /** True when using the feature spends AI tokens in the background. */
  tokenCost?: boolean;
  /** Set iff a demo note exists for this topic (the id doubles as the demo
   *  lookup key). Unique across the registry. */
  demoTopic?: string;
  /** Key base into the `help` namespace: `topics.<id>`. Subkeys: `.what`,
   *  `.where`, optional `.setup` / `.cost` (probe with i18n.exists). */
  keyBase: string;
  /** Fully-qualified i18n key of the display name: settings:features.*.label
   *  for gated topics, help:topics.<id>.title for basics topics. */
  titleKey: string;
}

/** All topics in display order: HELP_GROUPS order, FeaturesPanel row order
 *  within each group. */
export const HELP_TOPICS: readonly HelpTopic[] = [
  // ── basics ────────────────────────────────────────────────────────────────
  {
    id: "editorBasics",
    group: "basics",
    icon: PenLine,
    keyBase: "topics.editorBasics",
    titleKey: "help:topics.editorBasics.title",
    syntax: [
      { code: "/", descKey: "topics.editorBasics.syntax.slash" },
      { code: "#tag", descKey: "topics.editorBasics.syntax.tag" },
    ],
  },
  {
    id: "wikilinks",
    group: "basics",
    icon: Brackets,
    demoTopic: "wikilinks",
    keyBase: "topics.wikilinks",
    titleKey: "help:topics.wikilinks.title",
    // Source: packages/editor/src/WikiLink.ts (WIKI_LINK_RE —
    // `[[Title]]` / `[[Title#Heading]]` / `[[Title|alias]]`).
    syntax: [
      { code: "[[Note]]", descKey: "topics.wikilinks.syntax.link" },
      { code: "[[Note#Heading]]", descKey: "topics.wikilinks.syntax.heading" },
      { code: "[[Note|shown text]]", descKey: "topics.wikilinks.syntax.alias" },
    ],
  },
  {
    id: "search",
    group: "basics",
    icon: Search,
    chord: "search",
    keyBase: "topics.search",
    titleKey: "help:topics.search.title",
  },
  {
    id: "commandPalette",
    group: "basics",
    icon: Command,
    chord: "command-palette",
    keyBase: "topics.commandPalette",
    titleKey: "help:topics.commandPalette.title",
  },
  {
    id: "taskTokens",
    group: "basics",
    icon: ListChecks,
    settingsCategory: "tasks",
    demoTopic: "taskTokens",
    keyBase: "topics.taskTokens",
    titleKey: "help:topics.taskTokens.title",
    // Source: crates/novalis-core/src/tasks/index.rs:29-44 (the token regexes)
    // and tasks/nldate.rs (natural-language date resolution in date fields).
    syntax: [
      { code: "- [ ] Call the bank", descKey: "topics.taskTokens.syntax.checkbox" },
      { code: "@due(2026-08-01)", descKey: "topics.taskTokens.syntax.due" },
      { code: "@start(2026-08-01)", descKey: "topics.taskTokens.syntax.start" },
      { code: "@remind(2026-08-01T09:00)", descKey: "topics.taskTokens.syntax.remind" },
      { code: "@priority(high)", descKey: "topics.taskTokens.syntax.priority" },
      { code: "@status(in-progress)", descKey: "topics.taskTokens.syntax.status" },
      { code: "@repeat(weekly)", descKey: "topics.taskTokens.syntax.repeat" },
      { code: "@project(launch)", descKey: "topics.taskTokens.syntax.project" },
      { code: "@epic(v2)", descKey: "topics.taskTokens.syntax.epic" },
      { code: "#errands", descKey: "topics.taskTokens.syntax.tag" },
      { code: "tomorrow · next friday · in 3 days", descKey: "topics.taskTokens.syntax.nlDates" },
    ],
  },
  {
    id: "cheatsheet",
    group: "basics",
    icon: Keyboard,
    chord: "cheatsheet",
    settingsCategory: "keybindings",
    keyBase: "topics.cheatsheet",
    titleKey: "help:topics.cheatsheet.title",
  },
  {
    id: "readingMode",
    group: "basics",
    icon: BookOpen,
    keyBase: "topics.readingMode",
    titleKey: "help:topics.readingMode.title",
  },
  {
    id: "versionHistory",
    group: "basics",
    icon: History,
    keyBase: "topics.versionHistory",
    titleKey: "help:topics.versionHistory.title",
  },

  // ── ai ────────────────────────────────────────────────────────────────────
  {
    id: "ai",
    group: "ai",
    feature: "ai",
    icon: Sparkles,
    settingsCategory: "ai",
    keyBase: "topics.ai",
    titleKey: "settings:features.ai.label",
  },
  {
    id: "ambientAi",
    group: "ai",
    customGate: "ambientAi",
    icon: Sparkles,
    settingsCategory: "ai",
    tokenCost: true,
    keyBase: "topics.ambientAi",
    titleKey: "settings:features.ambient.label",
  },
  {
    id: "aiMetaSuggestions",
    group: "ai",
    feature: "aiMetaSuggestions",
    icon: Sparkles,
    settingsCategory: "ai",
    keyBase: "topics.aiMetaSuggestions",
    titleKey: "settings:features.aiMetaSuggestions.label",
  },
  {
    id: "aiTemplates",
    group: "ai",
    feature: "aiTemplates",
    icon: FileText,
    settingsCategory: "ai",
    keyBase: "topics.aiTemplates",
    titleKey: "settings:features.aiTemplates.label",
  },
  {
    id: "taskExtract",
    group: "ai",
    feature: "taskExtract",
    icon: ListTodo,
    settingsCategory: "ai",
    keyBase: "topics.taskExtract",
    titleKey: "settings:features.taskExtract.label",
  },
  {
    id: "weeklyReview",
    group: "ai",
    feature: "weeklyReview",
    icon: CalendarCheck,
    settingsCategory: "ai",
    keyBase: "topics.weeklyReview",
    titleKey: "settings:features.weeklyReview.label",
  },
  {
    id: "vaultChat",
    group: "ai",
    feature: "vaultChat",
    icon: MessageSquare,
    settingsCategory: "ai",
    costMb: 130,
    keyBase: "topics.vaultChat",
    titleKey: "settings:features.vaultChat.label",
  },
  {
    id: "relatedNotes",
    group: "ai",
    feature: "relatedNotes",
    icon: Orbit,
    settingsCategory: "ai",
    costMb: 130,
    keyBase: "topics.relatedNotes",
    titleKey: "settings:features.relatedNotes.label",
  },
  {
    id: "entityGraph",
    group: "ai",
    feature: "entityGraph",
    icon: Network,
    settingsCategory: "ai",
    tokenCost: true,
    keyBase: "topics.entityGraph",
    titleKey: "settings:features.entityGraph.label",
  },

  // ── editor ────────────────────────────────────────────────────────────────
  {
    id: "blockRefs",
    group: "editor",
    feature: "blockRefs",
    icon: Braces,
    demoTopic: "blockRefs",
    keyBase: "topics.blockRefs",
    titleKey: "settings:features.blockRefs.label",
    // Source: packages/editor/src/blockRefMatches.ts (` ^id` marker +
    // `((^id))` reference; id is base36, 4–32 chars).
    syntax: [
      { code: "^ab12", descKey: "topics.blockRefs.syntax.marker" },
      { code: "((^ab12))", descKey: "topics.blockRefs.syntax.reference" },
    ],
  },
  {
    id: "transclusion",
    group: "editor",
    feature: "transclusion",
    icon: Layers,
    demoTopic: "transclusion",
    keyBase: "topics.transclusion",
    titleKey: "settings:features.transclusion.label",
    // Source: packages/editor/src/embedMatches.ts (`![[target]]`, target may
    // carry a `#section` anchor).
    syntax: [
      { code: "![[Note]]", descKey: "topics.transclusion.syntax.note" },
      { code: "![[Note#Heading]]", descKey: "topics.transclusion.syntax.section" },
    ],
  },
  {
    id: "mermaid",
    group: "editor",
    feature: "mermaid",
    icon: Workflow,
    demoTopic: "mermaid",
    keyBase: "topics.mermaid",
    titleKey: "settings:features.mermaid.label",
    // Source: packages/editor/src/MermaidCodeBlock.ts (a ```mermaid fence).
    syntax: [{ code: "```mermaid", descKey: "topics.mermaid.syntax.fence" }],
  },
  {
    id: "math",
    group: "editor",
    feature: "math",
    icon: Sigma,
    demoTopic: "math",
    keyBase: "topics.math",
    titleKey: "settings:features.math.label",
    // Source: packages/editor/src/mathMatches.ts (`$$…$$` block, `$…$` inline
    // with the no-space/no-trailing-digit currency guards).
    syntax: [
      { code: "$inline$", descKey: "topics.math.syntax.inline" },
      { code: "$$block$$", descKey: "topics.math.syntax.block" },
    ],
  },
  {
    id: "codeHighlight",
    group: "editor",
    feature: "codeHighlight",
    icon: Code,
    keyBase: "topics.codeHighlight",
    titleKey: "settings:features.codeHighlight.label",
    // Source: packages/editor/src/lowlightLazy.ts (grammar named by the fence).
    syntax: [{ code: "```rust", descKey: "topics.codeHighlight.syntax.fence" }],
  },
  {
    id: "callouts",
    group: "editor",
    feature: "callouts",
    icon: Info,
    demoTopic: "callouts",
    keyBase: "topics.callouts",
    titleKey: "settings:features.callouts.label",
    // Source: packages/editor/src/parseCallout.ts (`[!type] optional title` at
    // the start of a blockquote; KNOWN_TYPES, unknown falls back to note).
    syntax: [
      { code: "> [!NOTE]", descKey: "topics.callouts.syntax.basic" },
      { code: "> [!warning] Custom title", descKey: "topics.callouts.syntax.titled" },
    ],
  },
  {
    id: "tagAutocomplete",
    group: "editor",
    feature: "tagAutocomplete",
    icon: Hash,
    keyBase: "topics.tagAutocomplete",
    titleKey: "settings:features.tagAutocomplete.label",
  },
  {
    id: "outline",
    group: "editor",
    feature: "outline",
    icon: ListTree,
    keyBase: "topics.outline",
    titleKey: "settings:features.outline.label",
  },

  // ── workspace ─────────────────────────────────────────────────────────────
  {
    id: "todayView",
    group: "workspace",
    feature: "todayView",
    icon: Sun,
    chord: "view-today",
    keyBase: "topics.todayView",
    titleKey: "settings:features.todayView.label",
  },
  {
    id: "tasks",
    group: "workspace",
    feature: "tasks",
    icon: SquareCheckBig,
    chord: "view-tasks",
    settingsCategory: "tasks",
    keyBase: "topics.tasks",
    titleKey: "settings:features.tasks.label",
  },
  {
    id: "calendar",
    group: "workspace",
    feature: "calendar",
    icon: Calendar,
    chord: "view-calendar",
    settingsCategory: "calendar",
    keyBase: "topics.calendar",
    titleKey: "settings:features.calendar.label",
  },

  // ── graph ─────────────────────────────────────────────────────────────────
  {
    id: "backlinks",
    group: "graph",
    feature: "backlinks",
    icon: Link2,
    keyBase: "topics.backlinks",
    titleKey: "settings:features.backlinks.label",
  },
  {
    id: "graphView",
    group: "graph",
    feature: "graphView",
    icon: Waypoints,
    chord: "view-graph",
    keyBase: "topics.graphView",
    titleKey: "settings:features.graphView.label",
  },
  {
    id: "properties",
    group: "graph",
    feature: "properties",
    icon: List,
    demoTopic: "properties",
    keyBase: "topics.properties",
    titleKey: "settings:features.properties.label",
    // Source: crates/novalis-core/src/index/properties.rs (typed values +
    // `[[Title]]` relation targets) and PropertyValue in ipc/bindings.ts.
    syntax: [
      { code: "---", descKey: "topics.properties.syntax.frontmatter" },
      { code: "status: active", descKey: "topics.properties.syntax.text" },
      { code: "rating: 4", descKey: "topics.properties.syntax.number" },
      { code: "done: true", descKey: "topics.properties.syntax.checkbox" },
      { code: "tags: [alpha, beta]", descKey: "topics.properties.syntax.list" },
      { code: "project: \"[[Launch]]\"", descKey: "topics.properties.syntax.relation" },
    ],
  },

  // ── power ─────────────────────────────────────────────────────────────────
  {
    id: "queryEngine",
    group: "power",
    feature: "queryEngine",
    icon: Table2,
    chord: "view-query",
    demoTopic: "queryEngine",
    keyBase: "topics.queryEngine",
    titleKey: "settings:features.queryEngine.label",
    // Source: crates/novalis-core/src/index/query.rs lines 1-35 — the full
    // query DSL table, mirrored COMPLETELY (one row per term kind + negation).
    syntax: [
      { code: "word \"a phrase\"", descKey: "topics.queryEngine.syntax.fulltext" },
      { code: "tag:urgent", descKey: "topics.queryEngine.syntax.tag" },
      { code: "folder:Projects", descKey: "topics.queryEngine.syntax.folder" },
      { code: "title:launch", descKey: "topics.queryEngine.syntax.title" },
      { code: "path:2026/", descKey: "topics.queryEngine.syntax.path" },
      { code: "alias:acme", descKey: "topics.queryEngine.syntax.alias" },
      { code: "type:meeting", descKey: "topics.queryEngine.syntax.propEquals" },
      { code: "rating>=4", descKey: "topics.queryEngine.syntax.propCompare" },
      { code: "status!=done", descKey: "topics.queryEngine.syntax.propNotEquals" },
      { code: "project:[[Launch]]", descKey: "topics.queryEngine.syntax.relation" },
      { code: "has:task", descKey: "topics.queryEngine.syntax.hasFacet" },
      { code: "has:deadline", descKey: "topics.queryEngine.syntax.hasProp" },
      { code: "task.status:done", descKey: "topics.queryEngine.syntax.taskStatus" },
      { code: "task.priority:high", descKey: "topics.queryEngine.syntax.taskPriority" },
      { code: "task.due<2026-08-01", descKey: "topics.queryEngine.syntax.taskDue" },
      { code: "task.done:true", descKey: "topics.queryEngine.syntax.taskDone" },
      { code: "sort:modified:desc", descKey: "topics.queryEngine.syntax.sort" },
      { code: "sort:similarity:\"launch\"", descKey: "topics.queryEngine.syntax.sortSimilarity" },
      { code: "view:kanban", descKey: "topics.queryEngine.syntax.view" },
      { code: "-tag:archived", descKey: "topics.queryEngine.syntax.negate" },
    ],
  },
  {
    id: "dailyNotes",
    group: "power",
    feature: "dailyNotes",
    icon: NotebookPen,
    keyBase: "topics.dailyNotes",
    titleKey: "settings:features.dailyNotes.label",
  },
  {
    id: "plugins",
    group: "power",
    feature: "plugins",
    icon: Puzzle,
    settingsCategory: "plugins",
    keyBase: "topics.plugins",
    titleKey: "settings:features.plugins.label",
  },
  {
    id: "reminders",
    group: "power",
    feature: "reminders",
    icon: Bell,
    keyBase: "topics.reminders",
    titleKey: "settings:features.reminders.label",
  },

  // ── sync ──────────────────────────────────────────────────────────────────
  {
    id: "gitSync",
    group: "sync",
    customGate: "gitSync",
    icon: GitBranch,
    settingsCategory: "sync",
    keyBase: "topics.gitSync",
    titleKey: "settings:features.git.label",
  },
  {
    id: "p2pSync",
    group: "sync",
    feature: "p2pSync",
    icon: RefreshCw,
    settingsCategory: "sync",
    keyBase: "topics.p2pSync",
    titleKey: "settings:features.p2pSync.label",
  },
  {
    id: "calendarSync",
    group: "sync",
    feature: "calendarSync",
    icon: CalendarDays,
    settingsCategory: "calendar",
    keyBase: "topics.calendarSync",
    titleKey: "settings:features.calendarSync.label",
  },
  {
    id: "icsSubscriptions",
    group: "sync",
    feature: "icsSubscriptions",
    icon: Rss,
    settingsCategory: "calendar",
    keyBase: "topics.icsSubscriptions",
    titleKey: "settings:features.icsSubscriptions.label",
  },

  // ── media ─────────────────────────────────────────────────────────────────
  {
    id: "canvas",
    group: "media",
    feature: "canvas",
    icon: Shapes,
    chord: "view-canvas",
    demoTopic: "canvas",
    keyBase: "topics.canvas",
    titleKey: "settings:features.canvas.label",
  },
  {
    id: "pdfAnnotate",
    group: "media",
    feature: "pdfAnnotate",
    icon: Highlighter,
    keyBase: "topics.pdfAnnotate",
    titleKey: "settings:features.pdfAnnotate.label",
  },
  {
    id: "voice",
    group: "media",
    feature: "voice",
    icon: Mic,
    costMb: 142,
    keyBase: "topics.voice",
    titleKey: "settings:features.voice.label",
  },
];

/** Lookup by id (same objects as HELP_TOPICS). */
export const HELP_TOPIC_BY_ID: ReadonlyMap<HelpTopicId, HelpTopic> = new Map(
  HELP_TOPICS.map((t) => [t.id, t]),
);
