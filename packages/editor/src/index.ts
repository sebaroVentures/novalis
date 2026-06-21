// @novalis/editor
//
// A standalone, app-agnostic Markdown editor built on TipTap. The host passes
// markdown in and receives markdown out; it has no knowledge of Novalis's IPC
// or stores. `[[wikilinks]]` are decorated as clickable spans (see WikiLink)
// but stored as plain text — round-trip stays trivial. Math, Mermaid and
// callouts render via decorations / a code-block NodeView while keeping the
// Markdown plain, so round-trip stays trivial too.

export { NovalisEditor, getMarkdown } from "./NovalisEditor";
export type { NovalisEditorProps } from "./NovalisEditor";
export { extractHeadings } from "./outline";
export type { OutlineItem } from "./outline";
export { Find, findInfo } from "./Find";
export type { FindMatchInfo } from "./Find";
export { SuggestRewrite, rewriteInfo, computeRewrite, wordDiff } from "./SuggestRewrite";
export type { RewriteInfo, RewritePlan, Hunk, DiffOp, SuggestRewriteLabels } from "./SuggestRewrite";
export { findMatches } from "./findMatches";
export { findMath } from "./mathMatches";
export { findEmbeds } from "./embedMatches";
export type { EmbedMatch } from "./embedMatches";
export { parseCallout } from "./parseCallout";
export { WikiLink } from "./WikiLink";
export type { WikiLinkOptions } from "./WikiLink";
export { Embed } from "./Embed";
export type { EmbedOptions, EmbedResult, EmbedLabels } from "./Embed";
export type { Editor } from "@tiptap/react";

export const EDITOR_PACKAGE_NAME = "@novalis/editor";
