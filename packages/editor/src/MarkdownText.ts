// MarkdownText: replaces tiptap-markdown's text-node markdown serializer,
// which corrupted files on every save. The stock serializer runs
// `state.text(escapeHTML(node.text))`, which
//   - entity-escapes `<`/`>` (`5 < 7` → `5 &lt; 7`) even though this editor
//     parses markdown with `html: false`, so there is no HTML to defend
//     against, and
//   - lets prosemirror-markdown's `esc()` backslash-escape `` ` * \ ~ [ ] _ ``
//     across the whole text, mangling `[[wikilinks]]` (`\[\[Note\]\]` — which
//     breaks the Rust link index and Obsidian compat), `![[embeds]]` and
//     `$math$` (`$\frac{a}{b}$` → `$\\frac{a}{b}$`).
// The damage was silent because markdown-it un-escapes on reload.
//
// This node keeps standard prosemirror-markdown escaping for ordinary text —
// a literal `*not bold*` still round-trips as literal text — but:
//   - never entity-escapes `<`/`>`; a `<…>` run that would re-parse as a
//     markdown autolink gets a round-trip-safe `\<` guard instead;
//   - emits `[[…]]` / `![[…]]` / `$…$` / `$$…$$` spans verbatim, using the
//     same pure matchers the decorations use (embedMatches / mathMatches /
//     WikiLink's regex), so serializer and renderer can never disagree;
//   - emits a leading `[!TYPE]` callout marker verbatim (via parseCallout),
//     so Obsidian still recognizes the callout after a Novalis edit;
//   - un-escapes lone `~` (only `~~` can open strikethrough; `~~` runs keep
//     their escapes).
//
// tiptap-markdown looks up serializer specs by extension name and prefers the
// registered extension's `storage.markdown` over its built-in default, so
// registering this node (with StarterKit's `text` disabled) is the sanctioned
// override point — no fork, no app-side change.

import { Node } from "@tiptap/core";
import type { MarkdownNodeSpec } from "tiptap-markdown";

import { findBlockRefs } from "./blockRefMatches";
import { findEmbeds } from "./embedMatches";
import { findMath } from "./mathMatches";
import { parseCallout } from "./parseCallout";
import { WIKI_LINK_RE } from "./WikiLink";

type SerializerState = Parameters<MarkdownNodeSpec["serialize"]>[0];

/** prosemirror-markdown keeps `out` and `atBlockStart` out of its public
 *  typings, but both are stable — tiptap-markdown's own serializer state
 *  subclass mutates `out` the same way (see its `render()` / trimInline). */
type SerializerInternals = { out: string; atBlockStart: boolean };

interface Span {
  from: number;
  to: number;
}

/** Ranges of `text` that must be emitted verbatim (no markdown escaping).
 *  `atParagraphStart` additionally protects a leading `[!TYPE]` callout
 *  marker, which only means anything at the start of a block's text. */
function protectedSpans(text: string, atParagraphStart: boolean): Span[] {
  const spans: Span[] = [];
  if (atParagraphStart && parseCallout(text)) {
    // parseCallout matched, so the first `]` is the one closing `[!TYPE]`.
    spans.push({ from: text.indexOf("["), to: text.indexOf("]") + 1 });
  }
  for (const m of findEmbeds(text)) spans.push({ from: m.from, to: m.to });
  for (const m of findMath(text)) spans.push({ from: m.from, to: m.to });
  // `((^id))` block references — base36 ids need no escaping, but protect them
  // so the serializer and the BlockRef decoration can never disagree (the same
  // contract embeds/math/wikilinks keep). The trailing ` ^id` marker is plain
  // text that also needs no escaping, so it is left to the ordinary path.
  for (const m of findBlockRefs(text)) spans.push({ from: m.from, to: m.to });
  WIKI_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_LINK_RE.exec(text)) !== null) {
    if (!m[1].trim()) continue;
    // The inner `[[…]]` of an `![[embed]]` is owned by findEmbeds — the same
    // skip WikiLink's decorations apply.
    if (text[m.index - 1] === "!") continue;
    spans.push({ from: m.index, to: m.index + m[0].length });
  }
  spans.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.from < last.to) continue; // overlap: leftmost span wins
    merged.push(span);
  }
  return merged;
}

// esc() escapes every `~`, but only `~~` can open/close strikethrough, so a
// lone tilde (`a ~ b`) needs no escape. Operates on esc() output, where every
// source `~` reads `\~`: un-escape exactly the ones not adjacent to another.
const LONE_TILDE_RE = /(?<!\\~)\\~(?!\\~)/g;

// `<…>` runs that markdown-it would re-parse as an autolink on reload
// (`<scheme:…>` or `<user@host>`). Everything else (`5 < 7`,
// `#include <vector>`) stays untouched, because with `html: false` angle
// brackets are otherwise inert. Mirrors markdown-it's autolink rule, slightly
// broader on the email side — over-guarding only costs a round-trip-safe `\<`.
const AUTOLINK_RE = /<(?=[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\u0000-\u0020]*>|[^<>\s@]+@[^<>\s]+>)/g;

/** Standard prosemirror-markdown escaping (incl. start-of-line rules), then
 *  relax lone `~` and guard autolink-shaped `<`. Post-processes only the bytes
 *  this call appended to `state.out`. */
function writeEscaped(state: SerializerState, segment: string): void {
  const internals = state as unknown as SerializerInternals;
  const start = internals.out.length;
  state.text(segment, true);
  const written = internals.out.slice(start);
  internals.out =
    internals.out.slice(0, start) +
    written.replace(LONE_TILDE_RE, "~").replace(AUTOLINK_RE, "\\<");
}

/** Drop-in replacement for the stock `text` node (StarterKit must be
 *  configured with `text: false`) carrying the round-trip-safe serializer.
 *  Text inside `code` marks / code blocks never reaches this serializer —
 *  prosemirror-markdown's `escape: false` path bypasses it — so code keeps
 *  its existing verbatim behavior. */
export const MarkdownText = Node.create({
  name: "text",
  group: "inline",

  addStorage() {
    const serialize: MarkdownNodeSpec["serialize"] = (state, node, _parent, index) => {
      const text: string = node.text ?? "";
      const internals = state as unknown as SerializerInternals;
      const write = (chunk: string, escape: boolean) => {
        if (!chunk) return;
        if (escape) writeEscaped(state, chunk);
        else state.text(chunk, false);
        // Once anything is written, later chunks of this node are mid-line;
        // keeps esc()'s start-of-line rules (`#`, `-`, `1.`) from firing on
        // a segment that merely follows a protected span.
        internals.atBlockStart = false;
      };
      let idx = 0;
      for (const span of protectedSpans(text, index === 0)) {
        write(text.slice(idx, span.from), true);
        write(text.slice(span.from, span.to), false);
        idx = span.to;
      }
      write(text.slice(idx), true);
    };

    return {
      markdown: {
        serialize,
        // parse side stays with tiptap-markdown's default (markdown-it).
      },
    };
  },
});
