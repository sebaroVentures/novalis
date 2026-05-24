// @novalis/editor
//
// The standalone Markdown editor: a TipTap core plus Novalis's custom
// extensions (wikilinks, callouts, math, mermaid, code, slash menu), exposed
// through a clean `load(markdown)` / `emitMarkdown()` API with injected
// callbacks (onResolveLink, onUploadImage, onChange) so it has zero coupling
// to the host app. The full editor is extracted from the legacy module in M1.

export const EDITOR_PACKAGE_NAME = "@novalis/editor";
