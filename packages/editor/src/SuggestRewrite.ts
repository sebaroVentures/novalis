import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";

// ── Pure diff core (exported for testing) ───────────────────────────────────

/** One span of a word-level diff between the original and the proposed text. */
export interface DiffOp {
  type: "eq" | "del" | "ins";
  text: string;
}

/** Tokenize as "word + its trailing whitespace" (falling back to a run of
 *  leading/standalone whitespace), so a word and the space after it move
 *  together — this stops lone spaces from matching across an edit and
 *  fragmenting one change into several. The concatenation of the tokens always
 *  equals the input, which keeps offset → position mapping exact. */
function tokenize(s: string): string[] {
  return s.match(/\S+\s*|\s+/g) ?? [];
}

/** Longest-common-subsequence word diff. Inputs are small (a selection), so the
 *  O(n·m) table is fine. Adjacent ops of the same type are coalesced so a
 *  multi-word change is one span, not a stutter of single-word ops. */
export function wordDiff(a: string, b: string): DiffOp[] {
  const at = tokenize(a);
  const bt = tokenize(b);
  const n = at.length;
  const m = bt.length;
  // lcs[i][j] = LCS length of at[i..] and bt[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = at[i] === bt[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const raw: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (at[i] === bt[j]) {
      raw.push({ type: "eq", text: at[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      raw.push({ type: "del", text: at[i] });
      i++;
    } else {
      raw.push({ type: "ins", text: bt[j] });
      j++;
    }
  }
  while (i < n) raw.push({ type: "del", text: at[i++] });
  while (j < m) raw.push({ type: "ins", text: bt[j++] });

  // Coalesce neighbours of the same type.
  const ops: DiffOp[] = [];
  for (const op of raw) {
    const last = ops[ops.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else ops.push({ ...op });
  }
  return ops;
}

/** A single reviewable change, in absolute document coordinates. A `del` covers
 *  `[from, to)` of existing text; an `ins` is a zero-width point (`from === to`)
 *  whose `text` is proposed for insertion. Changes that touch the same spot
 *  share a `group`, so a word-replacement (a del + an ins) is accepted or
 *  rejected as one unit. */
export interface Hunk {
  group: number;
  kind: "del" | "ins";
  from: number;
  to: number;
  text: string;
}

export interface RewritePlan {
  /** `inline` = per-word hunks over a clean single-textblock selection;
   *  `block`  = a whole-selection replace (selection crossed block boundaries
   *  or contained non-text nodes, so per-word mapping isn't reliable). */
  mode: "inline" | "block";
  from: number;
  to: number;
  hunks: Hunk[];
  groups: number[];
  /** The full proposed text — used verbatim by a `block`-mode apply. */
  newText: string;
}

/** Build a reviewable plan from a selection's original text and the proposal.
 *  `from`/`to` are document positions; `origText` MUST be
 *  `doc.textBetween(from, to, "\n")`. When the selection is a clean run of text
 *  in one block (`to - from === origText.length`), positions map linearly and we
 *  emit per-word hunks; otherwise we fall back to a single whole-selection
 *  replace that still previews and is accept/reject-able as one change. */
export function computeRewrite(
  from: number,
  to: number,
  origText: string,
  newText: string,
): RewritePlan {
  const linear = to - from === origText.length;
  if (!linear) {
    return {
      mode: "block",
      from,
      to,
      newText,
      groups: [0],
      hunks: [
        { group: 0, kind: "del", from, to, text: origText },
        { group: 0, kind: "ins", from: to, to, text: newText },
      ],
    };
  }

  const ops = wordDiff(origText, newText);
  const hunks: Hunk[] = [];
  const groups: number[] = [];
  let offset = 0;
  let group = 0;
  let inGroup = false;
  for (const op of ops) {
    if (op.type === "eq") {
      offset += op.text.length;
      inGroup = false;
      continue;
    }
    if (!inGroup) {
      group += 1;
      groups.push(group);
      inGroup = true;
    }
    if (op.type === "del") {
      hunks.push({ group, kind: "del", from: from + offset, to: from + offset + op.text.length, text: op.text });
      offset += op.text.length;
    } else {
      hunks.push({ group, kind: "ins", from: from + offset, to: from + offset, text: op.text });
    }
  }
  return { mode: "inline", from, to, hunks, groups, newText };
}

// ── The extension ───────────────────────────────────────────────────────────

type Decision = "included" | "excluded";

interface SuggestState {
  active: boolean;
  mode: "inline" | "block";
  from: number;
  to: number;
  hunks: Hunk[];
  groups: number[];
  /** group id → decision; absent means the default, `included`. */
  decisions: Record<number, Decision>;
  newText: string;
  deco: DecorationSet;
}

const EMPTY: SuggestState = {
  active: false,
  mode: "inline",
  from: 0,
  to: 0,
  hunks: [],
  groups: [],
  decisions: {},
  newText: "",
  deco: DecorationSet.empty,
};

export const suggestRewriteKey = new PluginKey<SuggestState>("nvSuggestRewrite");

export interface SuggestRewriteLabels {
  /** Tooltip on a kept change's control (clicking rejects it). */
  reject: string;
  /** Tooltip on a rejected change's control (clicking restores it). */
  restore: string;
}

const DEFAULT_LABELS: SuggestRewriteLabels = {
  reject: "Reject this change",
  restore: "Restore this change",
};

function insWidget(text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "nv-sg-ins";
  span.textContent = text;
  span.setAttribute("contenteditable", "false");
  return span;
}

function ctlWidget(excluded: boolean, labels: SuggestRewriteLabels): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "nv-sg-ctl";
  wrap.setAttribute("contenteditable", "false");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "nv-sg-ctl-btn" + (excluded ? " is-excluded" : "");
  btn.textContent = excluded ? "↶" : "✕";
  btn.title = excluded ? labels.restore : labels.reject;
  wrap.appendChild(btn);
  return wrap;
}

function buildDeco(doc: ProseMirrorNode, state: SuggestState, labels: SuggestRewriteLabels): DecorationSet {
  if (!state.active || state.hunks.length === 0) return DecorationSet.empty;
  const decos: Decoration[] = [];
  const isExcluded = (g: number) => state.decisions[g] === "excluded";

  for (const h of state.hunks) {
    if (h.kind === "del") {
      if (!isExcluded(h.group)) {
        decos.push(Decoration.inline(h.from, h.to, { class: "nv-sg-del" }));
      }
      // excluded delete = keep the original text untouched (no decoration).
    } else if (!isExcluded(h.group)) {
      decos.push(
        Decoration.widget(h.from, () => insWidget(h.text), {
          side: 1,
          key: `ins-${h.group}-${h.from}`,
          ignoreSelection: true,
          stopEvent: () => true,
        }),
      );
    }
  }

  // One control per group, at the group's leftmost position.
  for (const g of state.groups) {
    const anchor = Math.min(...state.hunks.filter((h) => h.group === g).map((h) => h.from));
    const excluded = isExcluded(g);
    decos.push(
      Decoration.widget(
        anchor,
        (view) => {
          const dom = ctlWidget(excluded, labels);
          dom.querySelector("button")?.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            view.dispatch(view.state.tr.setMeta(suggestRewriteKey, { type: "toggle", group: g }));
          });
          return dom;
        },
        { side: -1, key: `ctl-${g}-${excluded ? "x" : "o"}`, ignoreSelection: true, stopEvent: () => true },
      ),
    );
  }
  return DecorationSet.create(doc, decos);
}

export interface SuggestRewriteOptions {
  labels: SuggestRewriteLabels;
}

/** Track-changes review of an AI rewrite: shows the proposal as inline
 *  strike (removed) + green insert decorations with per-change accept/reject,
 *  and never mutates the document until an explicit apply — so Markdown
 *  round-trip is unaffected while a suggestion is under review (cf. Find). */
export const SuggestRewrite = Extension.create<SuggestRewriteOptions>({
  name: "nvSuggestRewrite",

  addOptions() {
    return { labels: DEFAULT_LABELS };
  },

  addProseMirrorPlugins() {
    const labels = this.options.labels;
    return [
      new Plugin<SuggestState>({
        key: suggestRewriteKey,
        state: {
          init: () => EMPTY,
          apply(tr, value): SuggestState {
            const meta = tr.getMeta(suggestRewriteKey) as
              | { type: "propose"; plan: RewritePlan }
              | { type: "toggle"; group: number }
              | { type: "clear" }
              | undefined;

            if (meta?.type === "clear") return EMPTY;

            if (meta?.type === "propose") {
              const next: SuggestState = {
                active: true,
                mode: meta.plan.mode,
                from: meta.plan.from,
                to: meta.plan.to,
                hunks: meta.plan.hunks,
                groups: meta.plan.groups,
                decisions: {},
                newText: meta.plan.newText,
                deco: DecorationSet.empty,
              };
              next.deco = buildDeco(tr.doc, next, labels);
              return next;
            }

            if (meta?.type === "toggle" && value.active) {
              const nextDecision: Decision =
                value.decisions[meta.group] === "excluded" ? "included" : "excluded";
              const decisions = { ...value.decisions, [meta.group]: nextDecision };
              const next: SuggestState = { ...value, decisions };
              next.deco = buildDeco(tr.doc, next, labels);
              return next;
            }

            if (!value.active) return value;

            // Remap positions through a document change made elsewhere; if our
            // range collapsed, drop the suggestion rather than show stale marks.
            if (tr.docChanged) {
              const map = tr.mapping;
              const from = map.map(value.from, -1);
              const to = map.map(value.to, 1);
              if (to <= from) return EMPTY;
              const hunks = value.hunks.map((h) => ({
                ...h,
                from: map.map(h.from, -1),
                to: map.map(h.to, 1),
              }));
              const next: SuggestState = { ...value, from, to, hunks };
              next.deco = buildDeco(tr.doc, next, labels);
              return next;
            }

            return value;
          },
        },
        props: {
          decorations(state) {
            return suggestRewriteKey.getState(state)?.deco ?? null;
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      /** Open a track-changes review of `newText` over the document range
       *  `[from, to)`. No-op (and clears any active review) when the proposal
       *  is identical to the current text. */
      proposeRewrite:
        (from: number, to: number, newText: string) =>
        ({ state, tr, dispatch }) => {
          if (from < 0 || to > state.doc.content.size || from >= to) return false;
          const origText = state.doc.textBetween(from, to, "\n");
          if (!newText.trim() || newText.trim() === origText.trim()) {
            if (dispatch) dispatch(tr.setMeta(suggestRewriteKey, { type: "clear" }));
            return false;
          }
          const plan = computeRewrite(from, to, origText, newText);
          if (dispatch) dispatch(tr.setMeta(suggestRewriteKey, { type: "propose", plan }));
          return true;
        },

      /** Toggle one change between kept and rejected. */
      toggleSuggestionGroup:
        (group: number) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(suggestRewriteKey, { type: "toggle", group }));
          return true;
        },

      /** Commit every kept change in one transaction, then end the review. */
      applySuggestions:
        () =>
        ({ state, tr, dispatch }) => {
          const s = suggestRewriteKey.getState(state);
          if (!s?.active) return false;
          if (dispatch) {
            const excluded = (g: number) => s.decisions[g] === "excluded";
            if (s.mode === "block") {
              if (!excluded(s.groups[0])) tr.insertText(s.newText, s.from, s.to);
            } else {
              const sorted = [...s.hunks].sort((a, b) => a.from - b.from || (a.kind === "del" ? -1 : 1));
              let result = "";
              let cur = s.from;
              for (const h of sorted) {
                if (h.from > cur) result += state.doc.textBetween(cur, h.from, "\n");
                if (h.kind === "del") {
                  if (excluded(h.group)) result += state.doc.textBetween(h.from, h.to, "\n");
                  cur = h.to;
                } else {
                  if (!excluded(h.group)) result += h.text;
                  cur = Math.max(cur, h.from);
                }
              }
              if (s.to > cur) result += state.doc.textBetween(cur, s.to, "\n");
              tr.insertText(result, s.from, s.to);
            }
            tr.setMeta(suggestRewriteKey, { type: "clear" });
            dispatch(tr);
          }
          return true;
        },

      /** Discard the review without changing the document. */
      clearSuggestions:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(suggestRewriteKey, { type: "clear" }));
          return true;
        },
    };
  },
});

export interface RewriteInfo {
  active: boolean;
  /** Number of distinct changes. */
  total: number;
  /** Changes currently kept (not rejected). */
  kept: number;
}

/** Read the live review state for a host-rendered control bar. */
export function rewriteInfo(editor: Editor): RewriteInfo {
  const s = suggestRewriteKey.getState(editor.state);
  if (!s?.active) return { active: false, total: 0, kept: 0 };
  const excluded = s.groups.filter((g) => s.decisions[g] === "excluded").length;
  return { active: true, total: s.groups.length, kept: s.groups.length - excluded };
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    nvSuggestRewrite: {
      proposeRewrite: (from: number, to: number, newText: string) => ReturnType;
      toggleSuggestionGroup: (group: number) => ReturnType;
      applySuggestions: () => ReturnType;
      clearSuggestions: () => ReturnType;
    };
  }
}
