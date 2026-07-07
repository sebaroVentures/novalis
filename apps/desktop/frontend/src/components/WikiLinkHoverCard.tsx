import { useEffect, useState } from "react";

import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api } from "../ipc/api";

export interface HoverTarget {
  title: string;
  rect: DOMRect;
}

type CardState =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "empty"; title: string }
  | { kind: "ready"; title: string; excerpt: string };

/** Strip a leading YAML frontmatter block and return the first lines as a
 *  single-line preview excerpt. */
function excerptOf(content: string): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  if (!body) return "";
  const text = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

/** A small preview card shown when hovering a `[[wikilink]]`. Resolves the
 *  target by title WITHOUT creating it (so hovering a not-yet-created note is a
 *  no-op), then shows its first lines. */
export function WikiLinkHoverCard({ target }: { target: HoverTarget | null }) {
  const { t } = useTranslation("links");
  const [state, setState] = useState<CardState>({ kind: "loading" });

  // Keyed on the title only — a new rect for the same title (re-hovering the
  // same link elsewhere) must not refetch or flash the loading state.
  const title = target?.title;
  useEffect(() => {
    if (title === undefined) return;
    let active = true;
    setState({ kind: "loading" });
    (async () => {
      try {
        const matches = await api.quickSearch(title);
        const hit = matches.find((m) => m.title.toLowerCase() === title.toLowerCase());
        if (!active) return;
        if (!hit) {
          setState({ kind: "missing" });
          return;
        }
        const note = await api.getNote(hit.path);
        if (!active) return;
        const excerpt = excerptOf(note.content);
        setState(
          excerpt ? { kind: "ready", title: note.title, excerpt } : { kind: "empty", title: note.title },
        );
      } catch {
        if (active) setState({ kind: "missing" });
      }
    })();
    return () => {
      active = false;
    };
  }, [title]);

  if (!target) return null;

  // Anchor below the link; clamp horizontally so a near-edge link stays on screen.
  const left = Math.min(target.rect.left, window.innerWidth - 304);
  const style = { left: Math.max(8, left), top: target.rect.bottom + 6 };

  return (
    <div
      className="fixed z-50 w-72 overflow-hidden rounded-lg border border-border-strong bg-surface p-3 text-sm shadow-xl"
      style={style}
    >
      {state.kind === "loading" && (
        <div className="flex items-center gap-2 text-xs text-fg-faint">
          <Loader2 size={13} className="animate-spin" />
          {target.title}
        </div>
      )}
      {state.kind === "missing" && (
        <div>
          <p className="truncate font-medium text-fg">{target.title}</p>
          <p className="mt-0.5 text-xs text-fg-faint">{t("notCreated")}</p>
        </div>
      )}
      {state.kind === "empty" && (
        <div>
          <p className="truncate font-medium text-fg">{state.title}</p>
          <p className="mt-0.5 text-xs text-fg-faint">{t("emptyNote")}</p>
        </div>
      )}
      {state.kind === "ready" && (
        <div>
          <p className="truncate font-medium text-fg">{state.title}</p>
          <p className="mt-1 line-clamp-4 text-xs text-fg-muted">{state.excerpt}</p>
        </div>
      )}
    </div>
  );
}
