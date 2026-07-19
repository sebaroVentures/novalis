import { useEffect, useRef, useState } from "react";

import { Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { getMarkdown, type Editor } from "@novalis/editor";

import { api, type NoteSummary, type PropertyValue } from "../../ipc/api";
import { useFeature } from "../../lib/features";
import { useAi } from "../../stores/aiStore";
import {
  Chip,
  extractJson,
  parseSuggestions,
  shortValue,
  SuggestionRow,
  type ExistingMeta,
  type Suggestions,
} from "./AiMetaSuggestions";

// Idle window after the last edit before ambient suggestions are computed. Well
// past the editor's autosave debounce (default 600ms) so a run fires only once
// the writer has genuinely settled — the background calls cost tokens.
const AMBIENT_SETTLE_MS = 4000;
// Skip trivially short notes — nothing worth linking, and no reason to spend a
// token round-trip on them.
const AMBIENT_MIN_CHARS = 60;
// Bound on how many candidate notes we describe to the model, to cap token cost.
const CANDIDATE_LIMIT = 60;
// Semantic neighbours (when the index is built) are the highest-signal
// candidates; fetch a handful and rank them first.
const RELATED_LIMIT = 12;

interface LinkSuggestion {
  /** Canonical title of an EXISTING note (what we insert as `[[title]]`). */
  title: string;
  path: string;
}

/** The title portion of every `[[wikilink]]` / `![[embed]]` in `md`, lowercased —
 *  used both to tell the model what's already linked and to drop re-proposals. */
function existingLinkTargets(md: string): Set<string> {
  const out = new Set<string>();
  for (const m of md.matchAll(/!?\[\[([^\]#|]+)/g)) {
    const t = m[1].trim().toLowerCase();
    if (t) out.add(t);
  }
  return out;
}

interface CandidatePool {
  /** Compact `{title, aliases?}` list sent to the model. */
  prompt: { title: string; aliases?: string[] }[];
  /** Semantic-neighbour titles, sent as a prioritization hint. */
  related: string[];
  /** Lowercased title OR alias -> the canonical existing note it names. */
  byKey: Map<string, LinkSuggestion>;
}

/** Assemble the candidate notes the current note might link to: semantic
 *  neighbours first (if the on-device index is built), then filled out with the
 *  most recently modified notes. Self, cloud-only placeholders, and
 *  already-linked notes are excluded. */
async function gatherCandidates(path: string, existing: Set<string>): Promise<CandidatePool> {
  let related: { path: string; title: string }[] = [];
  try {
    related = (await api.aiFindRelated(path, RELATED_LIMIT)).map((n) => ({
      path: n.path,
      title: n.title,
    }));
  } catch {
    // Not configured or stale — semantic ranking is a bonus, not required.
  }

  const all = await api.listNotes();
  const relatedPaths = new Set(related.map((r) => r.path));
  // Semantic neighbours first, then most-recently-modified to fill the budget.
  const rest = all
    .filter((n) => !relatedPaths.has(n.path))
    .sort((a, b) => (a.modified < b.modified ? 1 : -1));
  const byPath = new Map(all.map((n) => [n.path, n]));
  const ordered = [
    ...related.map((r) => byPath.get(r.path)).filter((n): n is NoteSummary => n != null),
    ...rest,
  ];

  const byKey = new Map<string, LinkSuggestion>();
  const prompt: { title: string; aliases?: string[] }[] = [];
  for (const n of ordered) {
    if (prompt.length >= CANDIDATE_LIMIT) break;
    if (n.path === path || n.cloudOnly || !n.title.trim()) continue;
    // Already linked → nothing to propose; keep it out of the prompt.
    if (existing.has(n.title.toLowerCase())) continue;
    const canon: LinkSuggestion = { title: n.title, path: n.path };
    byKey.set(n.title.toLowerCase(), canon);
    for (const a of n.aliases ?? []) {
      const k = a.trim().toLowerCase();
      if (k && !byKey.has(k)) byKey.set(k, canon);
    }
    prompt.push(n.aliases?.length ? { title: n.title, aliases: n.aliases } : { title: n.title });
  }

  return {
    prompt,
    related: related.map((r) => r.title),
    byKey,
  };
}

/** Parse the model's `{"links":[{title,reason}]}` payload, keeping only proposals
 *  that name a real candidate note (dropping hallucinations, self-links, and
 *  already-linked notes) and mapping each to its canonical title. */
function parseLinkSuggestions(
  raw: string,
  pool: CandidatePool,
  existing: Set<string>,
  selfPath: string,
): LinkSuggestion[] {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== "object") return [];
  const arr = (obj as Record<string, unknown>).links;
  if (!Array.isArray(arr)) return [];
  const out: LinkSuggestion[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const title =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof (item as Record<string, unknown>).title === "string"
          ? ((item as Record<string, unknown>).title as string)
          : null;
    if (!title) continue;
    const canon = pool.byKey.get(title.trim().toLowerCase());
    if (!canon || canon.path === selfPath) continue;
    if (existing.has(canon.title.toLowerCase())) continue;
    if (seen.has(canon.path)) continue;
    seen.add(canon.path);
    out.push(canon);
  }
  return out;
}

export interface AmbientSuggestionsProps extends ExistingMeta {
  path: string;
  noteTitle: string;
  /** The pane's live editor — the body source and the wikilink insertion target. */
  editor: Editor | null;
  /** The "Ambient AI suggestions" preference (off by default). */
  enabled: boolean;
  /** All vault tags, offered to the model as preferred tag vocabulary. */
  knownTags: string[];
  onAcceptTag: (tag: string) => Promise<void>;
  onAcceptAlias: (alias: string) => Promise<void>;
  onAcceptProperty: (key: string, value: PropertyValue) => Promise<void>;
}

/** Ambient AI: after an edit settles, quietly compute link + tag/alias/property
 *  suggestions in the background (only when enabled AND a provider is configured)
 *  and surface them as accept/reject chips. Accepting a link inserts `[[title]]`
 *  at the cursor; accepting metadata reuses the frontmatter writers. Fully
 *  silent while loading or on failure — it must never interrupt writing. */
export function AmbientSuggestions(props: AmbientSuggestionsProps) {
  const { t } = useTranslation("ai");
  const connections = useAi((s) => s.connections);
  const selectedId = useAi((s) => s.selectedConnectionId);
  const propertiesOn = useFeature("properties");

  const [links, setLinks] = useState<LinkSuggestion[]>([]);
  const [meta, setMeta] = useState<Suggestions>({ tags: [], aliases: [], properties: [] });

  // Ignore async results that resolve after a note switch, and skip re-running
  // for content we already analyzed (accepting a chip edits the doc, which is a
  // legitimate new settle; identical text is not).
  const reqId = useRef(0);
  const lastRun = useRef<string>("");

  const usable = connections.filter((c) => c.enabled && c.configured && c.available);
  const selected = usable.find((c) => c.id === selectedId) ?? usable[0] ?? null;
  const active = props.enabled && props.editor != null && selected != null;

  // Note-specific: switching notes clears the previous note's chips so they can
  // never be accepted against the current one.
  useEffect(() => {
    reqId.current++;
    lastRun.current = "";
    setLinks([]);
    setMeta({ tags: [], aliases: [], properties: [] });
  }, [props.path]);

  // Settle watcher: debounce doc changes and, once idle, compute suggestions in
  // the background. Re-armed if the note, editor, provider, or enabled flag
  // change; torn down (and silent) when inactive.
  useEffect(() => {
    if (!active || !props.editor) return;
    const editor = props.editor;
    let timer = 0;

    const run = async () => {
      const md = getMarkdown(editor);
      if (md.trim().length < AMBIENT_MIN_CHARS || md === lastRun.current) return;
      lastRun.current = md;
      const id = ++reqId.current;
      const runPath = props.path;
      const existing = existingLinkTargets(md);

      try {
        const pool = await gatherCandidates(runPath, existing);
        if (reqId.current !== id) return;

        const context = { title: props.noteTitle, markdown: md };
        const linkInput = JSON.stringify({
          candidates: pool.prompt,
          existingLinks: Array.from(existing).slice(0, 100),
          related: pool.related,
        });
        const metaInput = JSON.stringify({
          knownTags: props.knownTags.slice(0, 200),
          existingTags: props.existingTags,
          existingAliases: props.existingAliases,
          existingPropertyKeys: props.existingPropertyKeys,
        });

        const ai = useAi.getState();
        const [linkRes, metaRes] = await Promise.allSettled([
          pool.prompt.length > 0
            ? ai.collectAiAction({
                connectionId: selected!.id,
                actionId: "suggest-links",
                notePath: runPath,
                context,
                userInput: linkInput,
              })
            : Promise.resolve("{}"),
          ai.collectAiAction({
            connectionId: selected!.id,
            actionId: "suggest-meta",
            notePath: runPath,
            context,
            userInput: metaInput,
          }),
        ]);
        if (reqId.current !== id) return;

        if (linkRes.status === "fulfilled") {
          setLinks(parseLinkSuggestions(linkRes.value, pool, existing, runPath));
        }
        if (metaRes.status === "fulfilled") {
          setMeta(
            parseSuggestions(metaRes.value, {
              existingTags: props.existingTags,
              existingAliases: props.existingAliases,
              existingPropertyKeys: props.existingPropertyKeys,
            }),
          );
        }
      } catch {
        // Ambient means unobtrusive: a failed lookup shows nothing at all.
      }
    };

    const onUpdate = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void run(), AMBIENT_SETTLE_MS);
    };
    editor.on("update", onUpdate);
    return () => {
      window.clearTimeout(timer);
      editor.off("update", onUpdate);
    };
    // selected is derived; key on its id so a provider change re-arms.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, props.editor, props.path, selected?.id, props.noteTitle]);

  const acceptLink = (s: LinkSuggestion) => {
    setLinks((cur) => cur.filter((x) => x.path !== s.path));
    // Insert as literal `[[title]]` text; the editor's WikiLink decoration
    // renders it and autosave persists it like any other edit.
    props.editor?.chain().focus().insertContent(`[[${s.title}]] `).run();
  };
  const dismissLink = (s: LinkSuggestion) =>
    setLinks((cur) => cur.filter((x) => x.path !== s.path));

  const acceptTag = (tag: string) => {
    setMeta((s) => ({ ...s, tags: s.tags.filter((x) => x !== tag) }));
    void props.onAcceptTag(tag);
  };
  const acceptAlias = (alias: string) => {
    setMeta((s) => ({ ...s, aliases: s.aliases.filter((x) => x !== alias) }));
    void props.onAcceptAlias(alias);
  };
  const acceptProperty = (key: string, value: PropertyValue) => {
    setMeta((s) => ({ ...s, properties: s.properties.filter((p) => p.key !== key) }));
    void props.onAcceptProperty(key, value);
  };
  const dismissTag = (tag: string) =>
    setMeta((s) => ({ ...s, tags: s.tags.filter((x) => x !== tag) }));
  const dismissAlias = (alias: string) =>
    setMeta((s) => ({ ...s, aliases: s.aliases.filter((x) => x !== alias) }));
  const dismissProperty = (key: string) =>
    setMeta((s) => ({ ...s, properties: s.properties.filter((p) => p.key !== key) }));

  // With the `properties` feature off, property chips are hidden and uncounted —
  // accepting one would silently write frontmatter no visible surface shows.
  const metaView = propertiesOn ? meta : { ...meta, properties: [] };
  const total =
    links.length + metaView.tags.length + metaView.aliases.length + metaView.properties.length;
  // Silent until there is something to offer — this must never nag mid-write.
  if (!active || total === 0) return null;

  const clearAll = () => {
    setLinks([]);
    setMeta({ tags: [], aliases: [], properties: [] });
  };

  return (
    <div className="flex flex-col gap-1.5 border-b border-border/60 bg-surface-2/30 px-4 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-faint">
          <Sparkles size={12} className="text-accent" />
          {t("ambient.title")}
        </span>
        <button
          type="button"
          onClick={clearAll}
          aria-label={t("meta.close")}
          className="rounded-md p-0.5 text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        {links.length > 0 && (
          <SuggestionRow label={t("ambient.links")}>
            {links.map((s) => (
              <Chip
                key={s.path}
                text={s.title}
                onAccept={() => acceptLink(s)}
                onDismiss={() => dismissLink(s)}
                addLabel={t("meta.add")}
                dismissLabel={t("meta.dismiss")}
              />
            ))}
          </SuggestionRow>
        )}
        {metaView.tags.length > 0 && (
          <SuggestionRow label={t("meta.tags")}>
            {metaView.tags.map((tag) => (
              <Chip
                key={tag}
                text={`#${tag}`}
                onAccept={() => acceptTag(tag)}
                onDismiss={() => dismissTag(tag)}
                addLabel={t("meta.add")}
                dismissLabel={t("meta.dismiss")}
              />
            ))}
          </SuggestionRow>
        )}
        {metaView.aliases.length > 0 && (
          <SuggestionRow label={t("meta.aliases")}>
            {metaView.aliases.map((alias) => (
              <Chip
                key={alias}
                text={alias}
                onAccept={() => acceptAlias(alias)}
                onDismiss={() => dismissAlias(alias)}
                addLabel={t("meta.add")}
                dismissLabel={t("meta.dismiss")}
              />
            ))}
          </SuggestionRow>
        )}
        {metaView.properties.length > 0 && (
          <SuggestionRow label={t("meta.properties")}>
            {metaView.properties.map((p) => (
              <Chip
                key={p.key}
                text={`${p.key}: ${shortValue(p.value)}`}
                onAccept={() => acceptProperty(p.key, p.value)}
                onDismiss={() => dismissProperty(p.key)}
                addLabel={t("meta.add")}
                dismissLabel={t("meta.dismiss")}
              />
            ))}
          </SuggestionRow>
        )}
      </div>
    </div>
  );
}
