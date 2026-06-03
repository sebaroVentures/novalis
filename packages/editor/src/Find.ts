import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Editor } from "@tiptap/react";

import { findMatches } from "./findMatches";

interface Match {
  from: number;
  to: number;
}

interface FindState {
  query: string;
  caseSensitive: boolean;
  matches: Match[];
  active: number;
  deco: DecorationSet;
}

export const findPluginKey = new PluginKey<FindState>("nvFind");

/** Collect match ranges per text node (positions map directly to the doc).
 *  Matches that straddle inline-formatting boundaries are not found — an
 *  accepted limitation that keeps positions exact and avoids cross-block hits. */
function computeMatches(doc: ProseMirrorNode, query: string, caseSensitive: boolean): Match[] {
  if (!query) return [];
  const matches: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const off of findMatches(node.text, query, caseSensitive)) {
      matches.push({ from: pos + off, to: pos + off + query.length });
    }
  });
  return matches;
}

function buildDeco(doc: ProseMirrorNode, matches: Match[], active: number): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, {
        class: i === active ? "nv-find-match nv-find-current" : "nv-find-match",
      }),
    ),
  );
}

export interface FindMatchInfo {
  total: number;
  /** 1-based index of the active match, or 0 when there are none. */
  current: number;
}

/** Read the current match count + position from the editor's find plugin. */
export function findInfo(editor: Editor): FindMatchInfo {
  const s = findPluginKey.getState(editor.state);
  return {
    total: s?.matches.length ?? 0,
    current: s && s.matches.length ? s.active + 1 : 0,
  };
}

/** In-note find & replace. Highlights matches via decorations (no document
 *  mutation until an explicit replace), so Markdown round-trip is unaffected. */
export const Find = Extension.create({
  name: "nvFind",

  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findPluginKey,
        state: {
          init: () => ({
            query: "",
            caseSensitive: false,
            matches: [],
            active: -1,
            deco: DecorationSet.empty,
          }),
          apply(tr, value, _oldState, newState) {
            const meta = tr.getMeta(findPluginKey) as
              | Partial<Pick<FindState, "query" | "caseSensitive" | "active">>
              | undefined;
            let { query, caseSensitive, active } = value;
            let recompute = tr.docChanged;
            if (meta) {
              if (meta.query !== undefined) {
                query = meta.query;
                recompute = true;
              }
              if (meta.caseSensitive !== undefined) {
                caseSensitive = meta.caseSensitive;
                recompute = true;
              }
              if (meta.active !== undefined) active = meta.active;
            }
            let matches = value.matches;
            if (recompute) {
              matches = computeMatches(newState.doc, query, caseSensitive);
              if (active >= matches.length) active = matches.length ? 0 : -1;
              if (active < 0 && matches.length) active = 0;
            }
            return { query, caseSensitive, matches, active, deco: buildDeco(newState.doc, matches, active) };
          },
        },
        props: {
          decorations(state) {
            return findPluginKey.getState(state)?.deco ?? null;
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      setSearch:
        (query: string, caseSensitive: boolean) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(findPluginKey, { query, caseSensitive }));
          return true;
        },
      clearSearch:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(findPluginKey, { query: "", active: -1 }));
          return true;
        },
      findNext:
        () =>
        ({ tr, state, dispatch }) => {
          const ps = findPluginKey.getState(state);
          if (!ps || ps.matches.length === 0) return false;
          const next = ps.active < 0 ? 0 : (ps.active + 1) % ps.matches.length;
          const m = ps.matches[next];
          if (dispatch) {
            dispatch(
              tr
                .setMeta(findPluginKey, { active: next })
                .setSelection(TextSelection.create(tr.doc, m.from, m.to))
                .scrollIntoView(),
            );
          }
          return true;
        },
      findPrev:
        () =>
        ({ tr, state, dispatch }) => {
          const ps = findPluginKey.getState(state);
          if (!ps || ps.matches.length === 0) return false;
          const prev = ps.active <= 0 ? ps.matches.length - 1 : ps.active - 1;
          const m = ps.matches[prev];
          if (dispatch) {
            dispatch(
              tr
                .setMeta(findPluginKey, { active: prev })
                .setSelection(TextSelection.create(tr.doc, m.from, m.to))
                .scrollIntoView(),
            );
          }
          return true;
        },
      replaceCurrent:
        (replacement: string) =>
        ({ tr, state, dispatch }) => {
          const ps = findPluginKey.getState(state);
          if (!ps || ps.active < 0 || ps.active >= ps.matches.length) return false;
          const m = ps.matches[ps.active];
          if (dispatch) dispatch(tr.insertText(replacement, m.from, m.to));
          return true;
        },
      replaceAll:
        (replacement: string) =>
        ({ tr, state, dispatch }) => {
          const ps = findPluginKey.getState(state);
          if (!ps || ps.matches.length === 0) return false;
          if (dispatch) {
            // Back-to-front so earlier positions stay valid as we edit.
            for (let i = ps.matches.length - 1; i >= 0; i--) {
              const m = ps.matches[i];
              tr.insertText(replacement, m.from, m.to);
            }
            dispatch(tr);
          }
          return true;
        },
    };
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    nvFind: {
      setSearch: (query: string, caseSensitive: boolean) => ReturnType;
      clearSearch: () => ReturnType;
      findNext: () => ReturnType;
      findPrev: () => ReturnType;
      replaceCurrent: (replacement: string) => ReturnType;
      replaceAll: (replacement: string) => ReturnType;
    };
  }
}
