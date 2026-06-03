import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/** A heading entry for the document outline. `pos` is the ProseMirror document
 *  position of the heading node; use `pos + 1` to place the caret inside it. */
export interface OutlineItem {
  level: number;
  text: string;
  pos: number;
}

/** Walk a ProseMirror document and collect its headings, in document order. */
export function extractHeadings(doc: ProseMirrorNode): OutlineItem[] {
  const items: OutlineItem[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      const level = node.attrs.level;
      items.push({
        level: typeof level === "number" ? level : 1,
        text: node.textContent,
        pos,
      });
    }
    return true;
  });
  return items;
}
