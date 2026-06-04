// @novalis/editor
//
// A standalone, app-agnostic Markdown editor built on TipTap. The host passes
// markdown in and receives markdown out; it has no knowledge of Novalis's IPC
// or stores. `[[wikilinks]]` are decorated as clickable spans (see WikiLink)
// but stored as plain text — round-trip stays trivial. Math/Mermaid/callouts
// are still planned for a later pass.

export { NovalisEditor } from "./NovalisEditor";
export type { NovalisEditorProps } from "./NovalisEditor";
export { extractHeadings } from "./outline";
export type { OutlineItem } from "./outline";
export { Find, findInfo } from "./Find";
export type { FindMatchInfo } from "./Find";
export { findMatches } from "./findMatches";
export { parseCallout } from "./parseCallout";
export { WikiLink } from "./WikiLink";
export type { WikiLinkOptions } from "./WikiLink";
export type { Editor } from "@tiptap/react";

export const EDITOR_PACKAGE_NAME = "@novalis/editor";
