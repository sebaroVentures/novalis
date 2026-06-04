// Shared helpers for rendering tasks: strip the inline annotations/tags from a
// raw task line for display, and derive a stable color from a tag string (used
// by tag chips and the card accent stripe).

const ANNOTATION = /@(due|start|remind|priority|status|repeat|rrule|project|epic)\([^)]*\)/g;
const TAG = /(^|\s)#\w+/g;

/** The human-readable task title: the raw line text with @annotations and #tags
 *  removed and whitespace collapsed. */
export function displayText(text: string): string {
  return text.replace(ANNOTATION, "").replace(TAG, "$1").replace(/\s+/g, " ").trim();
}

/** Deterministic hue (0–359) for a tag, so a given tag is always the same color. */
export function tagHue(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) % 360;
  return h;
}

/** A solid color for a tag — used for the left accent stripe on a card. */
export function tagColor(tag: string): string {
  return `hsl(${tagHue(tag)} 55% 60%)`;
}

/** The note's display title: the file basename without its `.md` extension
 *  (e.g. `Projects/Work.md` → `Work`). */
export function noteTitleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/** The note's top-level folder — used as a lightweight "project" bucket for
 *  swimlanes/colors. `""` for a note that lives at the vault root. */
export function topFolderFromPath(path: string): string {
  const slash = path.indexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}
