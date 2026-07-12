import { useEffect, useRef, useState } from "react";

import { ChevronDown, ChevronRight, Loader2, Plus, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { PropertyValue } from "../../ipc/api";
import { useAi } from "../../stores/aiStore";

// Device-local "is the suggestions list expanded" bit (expanded default — a
// fresh run reopens it; see run()). Mirrors PropertiesPanel's nv:propsOpen.
const META_OPEN_KEY = "nv:aiMetaOpen";
function loadMetaOpen(): boolean {
  try {
    return localStorage.getItem(META_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}
function saveMetaOpen(open: boolean): void {
  try {
    localStorage.setItem(META_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export interface Suggestions {
  tags: string[];
  aliases: string[];
  properties: { key: string; value: PropertyValue }[];
}

export interface ExistingMeta {
  existingTags: string[];
  existingAliases: string[];
  existingPropertyKeys: string[];
}

export interface AiMetaSuggestionsProps extends ExistingMeta {
  path: string;
  noteTitle: string;
  /** Note body (markdown, without frontmatter). */
  body: string;
  /** All vault tags, offered to the model as preferred vocabulary. */
  knownTags: string[];
  onAcceptTag: (tag: string) => Promise<void>;
  onAcceptAlias: (alias: string) => Promise<void>;
  onAcceptProperty: (key: string, value: PropertyValue) => Promise<void>;
}

/** Pull the first JSON object out of a model response (tolerating code fences
 *  or stray prose around it). */
export function extractJson(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function coerceValue(kind: unknown, value: unknown): PropertyValue {
  switch (kind) {
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      return { kind: "number", value: Number.isFinite(n) ? n : null };
    }
    case "checkbox":
      return { kind: "checkbox", value: value === true || value === "true" };
    case "list": {
      const arr = Array.isArray(value)
        ? value.filter((x): x is string => typeof x === "string")
        : typeof value === "string"
          ? [value]
          : [];
      return { kind: "list", value: arr };
    }
    default:
      return { kind: "text", value: value == null ? "" : String(value) };
  }
}

export function shortValue(v: PropertyValue): string {
  switch (v.kind) {
    case "list":
      return v.value.join(", ");
    case "checkbox":
      return v.value ? "✓" : "✗";
    case "number":
      return v.value == null ? "" : String(v.value);
    default:
      return v.value;
  }
}

/** Parse + sanitize a suggestion payload, dropping anything the note already has. */
export function parseSuggestions(raw: string, existing: ExistingMeta): Suggestions {
  const obj = extractJson(raw);
  if (!obj || typeof obj !== "object") return { tags: [], aliases: [], properties: [] };
  const rec = obj as Record<string, unknown>;
  const lc = (a: string[]) => new Set(a.map((x) => x.toLowerCase()));
  const haveT = lc(existing.existingTags);
  const haveA = lc(existing.existingAliases);
  const haveK = lc(existing.existingPropertyKeys);

  const tags = Array.isArray(rec.tags)
    ? Array.from(
        new Set(
          rec.tags
            .filter((t): t is string => typeof t === "string")
            .map((t) => t.replace(/^#/, "").trim().toLowerCase())
            .filter((t) => t && !haveT.has(t)),
        ),
      )
    : [];

  const aliases = Array.isArray(rec.aliases)
    ? Array.from(
        new Set(
          rec.aliases
            .filter((a): a is string => typeof a === "string")
            .map((a) => a.trim())
            .filter((a) => a && !haveA.has(a.toLowerCase())),
        ),
      )
    : [];

  const properties: Suggestions["properties"] = [];
  const seenKeys = new Set<string>();
  if (Array.isArray(rec.properties)) {
    for (const p of rec.properties) {
      if (!p || typeof p !== "object") continue;
      const pr = p as Record<string, unknown>;
      if (typeof pr.key !== "string") continue;
      const key = pr.key.trim();
      const lower = key.toLowerCase();
      if (!key || haveK.has(lower) || seenKeys.has(lower)) continue;
      seenKeys.add(lower);
      properties.push({ key, value: coerceValue(pr.kind, pr.value) });
    }
  }

  return { tags, aliases, properties };
}

/** "Suggest metadata": runs the hidden `suggest-meta` action and renders the
 *  proposed tags / aliases / typed properties as accept (＋) / dismiss (✕) chips.
 *  Accepting writes only to frontmatter (via the parent's coordinated writers);
 *  the note body is never touched. */
export function AiMetaSuggestions(props: AiMetaSuggestionsProps) {
  const { t } = useTranslation("ai");
  const connections = useAi((s) => s.connections);
  const selectedId = useAi((s) => s.selectedConnectionId);

  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [sug, setSug] = useState<Suggestions>({ tags: [], aliases: [], properties: [] });
  const [open, setOpen] = useState(loadMetaOpen);

  const toggleOpen = () =>
    setOpen((v) => {
      saveMetaOpen(!v);
      return !v;
    });

  // Suggestions are note-specific: switching notes (the pane re-renders without
  // remounting us) resets back to the "Suggest metadata" affordance so we never
  // show — or accept — the previous note's chips against the current one. The
  // device-local `open` pref is intentionally preserved (mirrors PropertiesPanel).
  // `pathRef` lets an in-flight run() detect it resolved after such a switch.
  const pathRef = useRef(props.path);
  useEffect(() => {
    pathRef.current = props.path;
    setStatus("idle");
    setError(null);
    setSug({ tags: [], aliases: [], properties: [] });
  }, [props.path]);

  const usable = connections.filter((c) => c.enabled && c.configured && c.available);
  const selected = usable.find((c) => c.id === selectedId) ?? usable[0] ?? null;
  if (!selected) return null; // no AI configured → no affordance

  const reset = () => {
    setStatus("idle");
    setError(null);
    setSug({ tags: [], aliases: [], properties: [] });
  };

  const run = async () => {
    if (!props.body.trim()) return;
    const runPath = props.path;
    // A deliberate "Suggest metadata" always reveals its result, even if the
    // list was left collapsed from a previous note.
    setOpen(true);
    saveMetaOpen(true);
    setStatus("loading");
    setError(null);
    try {
      const userInput = JSON.stringify({
        knownTags: props.knownTags.slice(0, 200),
        existingTags: props.existingTags,
        existingAliases: props.existingAliases,
        existingPropertyKeys: props.existingPropertyKeys,
      });
      const raw = await useAi.getState().collectAiAction({
        connectionId: selected.id,
        actionId: "suggest-meta",
        notePath: props.path,
        context: { title: props.noteTitle, markdown: props.body },
        userInput,
      });
      if (pathRef.current !== runPath) return; // navigated away mid-request
      setSug(
        parseSuggestions(raw, {
          existingTags: props.existingTags,
          existingAliases: props.existingAliases,
          existingPropertyKeys: props.existingPropertyKeys,
        }),
      );
      setStatus("ready");
    } catch (e) {
      if (pathRef.current !== runPath) return; // navigated away mid-request
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  };

  const acceptTag = (tag: string) => {
    setSug((s) => ({ ...s, tags: s.tags.filter((x) => x !== tag) }));
    void props.onAcceptTag(tag);
  };
  const acceptAlias = (alias: string) => {
    setSug((s) => ({ ...s, aliases: s.aliases.filter((x) => x !== alias) }));
    void props.onAcceptAlias(alias);
  };
  const acceptProperty = (key: string, value: PropertyValue) => {
    setSug((s) => ({ ...s, properties: s.properties.filter((p) => p.key !== key) }));
    void props.onAcceptProperty(key, value);
  };
  const dismissTag = (tag: string) =>
    setSug((s) => ({ ...s, tags: s.tags.filter((x) => x !== tag) }));
  const dismissAlias = (alias: string) =>
    setSug((s) => ({ ...s, aliases: s.aliases.filter((x) => x !== alias) }));
  const dismissProperty = (key: string) =>
    setSug((s) => ({ ...s, properties: s.properties.filter((p) => p.key !== key) }));

  if (status === "idle") {
    return (
      <button
        type="button"
        onClick={() => void run()}
        className="flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <Sparkles size={13} className="text-accent" />
        {t("meta.suggest")}
      </button>
    );
  }

  const total = sug.tags.length + sug.aliases.length + sug.properties.length;
  const empty = total === 0;

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-2/40 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1.5 rounded text-[11px] font-medium uppercase tracking-wide text-fg-faint transition-colors hover:text-fg-muted"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <Sparkles size={12} className="text-accent" />
          {t("meta.title")}
          {!open && status === "ready" && !empty && (
            <span className="tabular-nums">({total})</span>
          )}
        </button>
        <button
          type="button"
          onClick={reset}
          aria-label={t("meta.close")}
          className="rounded-md p-0.5 text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <X size={13} />
        </button>
      </div>

      {status === "loading" && (
        <span className="flex items-center gap-1.5 py-0.5 text-xs text-fg-faint">
          <Loader2 size={12} className="animate-spin" />
          {t("meta.analyzing")}
        </span>
      )}

      {status === "error" && (
        <div className="flex items-center justify-between gap-2 py-0.5 text-xs">
          <span className="truncate text-danger">{error ?? t("meta.error")}</span>
          <button
            type="button"
            onClick={() => void run()}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
          >
            {t("meta.retry")}
          </button>
        </div>
      )}

      {open && status === "ready" && empty && (
        <span className="py-0.5 text-xs text-fg-faint">{t("meta.none")}</span>
      )}

      {open && status === "ready" && !empty && (
        <div className="flex flex-col gap-1.5">
          {sug.tags.length > 0 && (
            <SuggestionRow label={t("meta.tags")}>
              {sug.tags.map((tag) => (
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
          {sug.aliases.length > 0 && (
            <SuggestionRow label={t("meta.aliases")}>
              {sug.aliases.map((alias) => (
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
          {sug.properties.length > 0 && (
            <SuggestionRow label={t("meta.properties")}>
              {sug.properties.map((p) => (
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
      )}
    </div>
  );
}

export function SuggestionRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-14 shrink-0 pt-1 text-[11px] uppercase tracking-wide text-fg-faint">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

export function Chip({
  text,
  onAccept,
  onDismiss,
  addLabel,
  dismissLabel,
}: {
  text: string;
  onAccept: () => void;
  onDismiss: () => void;
  addLabel: string;
  dismissLabel: string;
}) {
  return (
    <span className="flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-xs text-fg">
      <span className="max-w-[14rem] truncate">{text}</span>
      <button
        type="button"
        onClick={onAccept}
        aria-label={addLabel}
        title={addLabel}
        className="rounded-full p-0.5 text-accent transition-colors hover:bg-accent-soft"
      >
        <Plus size={12} />
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismissLabel}
        title={dismissLabel}
        className="rounded-full p-0.5 text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
      >
        <X size={12} />
      </button>
    </span>
  );
}
