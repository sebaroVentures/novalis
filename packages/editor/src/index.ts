// @novalis/editor
//
// A standalone, app-agnostic Markdown editor built on TipTap. The host passes
// markdown in and receives markdown out; it has no knowledge of Novalis's IPC
// or stores. Math/Mermaid/callouts and clickable wikilinks are planned for a
// later pass — `[[wikilinks]]` are preserved as text and resolved by the
// backend's link graph today.

export { NovalisEditor } from "./NovalisEditor";
export type { NovalisEditorProps } from "./NovalisEditor";

export const EDITOR_PACKAGE_NAME = "@novalis/editor";
