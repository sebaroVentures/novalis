import { ListTree, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { type OutlineItem } from "@novalis/editor";

interface OutlinePanelProps {
  headings: OutlineItem[];
  onJump: (pos: number) => void;
  onClose: () => void;
}

/** Right-hand panel listing the open note's headings; clicking one scrolls the
 *  editor to it. Mirrors LinksPanel's aside so the two share the rail slot. */
export function OutlinePanel({ headings, onJump, onClose }: OutlinePanelProps) {
  const { t } = useTranslation("links");
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-border bg-surface">
      <header className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
          <ListTree size={14} />
          {t("outline")}
        </span>
        <button
          onClick={onClose}
          title={t("hideOutline")}
          className="rounded p-1 text-fg-faint transition-colors hover:bg-hover hover:text-fg"
        >
          <X size={14} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        {headings.length === 0 ? (
          <p className="px-3 text-xs text-fg-faint">{t("noHeadings")}</p>
        ) : (
          headings.map((h, i) => (
            <button
              key={`${h.pos}:${i}`}
              onClick={() => onJump(h.pos)}
              title={h.text}
              className="block w-full truncate px-3 py-1 text-left text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
              style={{ paddingLeft: `${(h.level - 1) * 12 + 12}px` }}
            >
              {h.text}
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
