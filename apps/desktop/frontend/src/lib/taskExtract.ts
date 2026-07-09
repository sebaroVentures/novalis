// Pure helpers for the meeting-note → task extraction review
// (components/ai/TaskExtractReview.tsx). Parse the model's JSON defensively,
// dedupe against the note, and format canonical task lines.
//
// The line format mirrors the Rust `task_line_from_extracted` (tasks/index.rs)
// exactly, so generated lines round-trip through the task index parser — dates
// `YYYY-MM-DD`, project slug `[a-z0-9-]+`, priority `urgent|high|medium|low`.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9-]+$/;
const TASK_LINE_RE = /^\s*- \[[ xX]\] (.+)$/;
const HEADING_RE = /^#{1,6}\s+/;
const ACTIONS_HEADING_RE = /^#{1,6}\s+Actions\s*$/i;
// Frontmatter block + body (same shape the editor uses); we keep the block to
// re-attach it on write.
const FRONTMATTER = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/;

export interface ProposedTask {
  text: string;
  due?: string;
  start?: string;
  project?: string;
  priority?: string;
}

/** Map a model priority to the grammar's vocabulary, tolerating the common
 *  "med" / "normal" shorthand; anything else yields undefined (dropped). */
export function normalizePriority(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "med" || v === "normal") return "medium";
  return v === "low" || v === "medium" || v === "high" || v === "urgent" ? v : undefined;
}

/** Pull the first JSON array out of a model response (tolerating code fences or
 *  stray prose around it). Returns null when nothing array-shaped is found. */
export function extractJsonArray(raw: string): unknown[] | null {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Coerce one raw item into a validated proposal, or null if it has no usable
 *  text. Invalid optional fields are silently dropped, never emitted. */
export function coerceTask(item: unknown): ProposedTask | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const text = typeof rec.text === "string" ? rec.text.trim() : "";
  if (!text) return null;
  const date = (v: unknown) =>
    typeof v === "string" && DATE_RE.test(v.trim()) ? v.trim() : undefined;
  const project =
    typeof rec.project === "string" && SLUG_RE.test(rec.project.trim())
      ? rec.project.trim()
      : undefined;
  return {
    text,
    due: date(rec.due),
    start: date(rec.start),
    project,
    priority: normalizePriority(rec.priority),
  };
}

/** Text of a task line stripped of `@annotations`, case, and whitespace, for
 *  dedupe comparison. */
export function normalizeTaskText(text: string): string {
  return text
    .replace(/@[a-z]+\([^)]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Normalized text of every existing `- [ ] / - [x]` task line in the note. */
export function existingTaskTexts(body: string): Set<string> {
  const set = new Set<string>();
  for (const line of body.split("\n")) {
    const m = line.match(TASK_LINE_RE);
    if (m) set.add(normalizeTaskText(m[1]));
  }
  return set;
}

/** The full parse pipeline: JSON → validated proposals, deduped against the
 *  note's existing task lines and within the batch. Malformed input yields an
 *  empty list (never garbage). */
export function parseExtractedTasks(raw: string, body: string): ProposedTask[] {
  const arr = extractJsonArray(raw);
  if (!arr) return [];
  const existing = existingTaskTexts(body);
  const seen = new Set<string>();
  const out: ProposedTask[] = [];
  for (const item of arr) {
    const p = coerceTask(item);
    if (!p) continue;
    const norm = normalizeTaskText(p.text);
    if (existing.has(norm) || seen.has(norm)) continue;
    seen.add(norm);
    out.push(p);
  }
  return out;
}

/** Canonical markdown task line — identical layout to the Rust
 *  `task_line_from_extracted`, so it round-trips through the task index. */
export function buildTaskLine(t: ProposedTask): string {
  const parts = [`- [ ] ${t.text.trim()}`];
  if (t.priority) parts.push(`@priority(${t.priority})`);
  if (t.start) parts.push(`@start(${t.start})`);
  if (t.due) parts.push(`@due(${t.due})`);
  if (t.project) parts.push(`@project(${t.project})`);
  return parts.join(" ");
}

/** Append task lines under an `## Actions` heading — reusing the existing one
 *  if present (inserting after its last non-blank line), else creating it at the
 *  end of the note. */
export function appendUnderActions(body: string, newLines: string[]): string {
  const lines = body.split("\n");
  const headingIdx = lines.findIndex((l) => ACTIONS_HEADING_RE.test(l.trim()));
  if (headingIdx === -1) {
    const trimmed = body.replace(/\n+$/, "");
    const prefix = trimmed.length ? `${trimmed}\n\n` : "";
    return `${prefix}## Actions\n\n${newLines.join("\n")}\n`;
  }
  // The section runs until the next heading (any level) or the end of the note.
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  const merged = [...lines.slice(0, insertAt), ...newLines, ...lines.slice(insertAt)];
  let out = merged.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  return out;
}

/** The leading YAML frontmatter block of a note (empty string if none). */
export function frontmatterOf(raw: string): string {
  const m = raw.match(FRONTMATTER);
  return m ? m[1] : "";
}
