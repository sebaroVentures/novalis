import { useEffect, useRef, useState } from "react";

import { ChevronDown, ChevronRight, MoreHorizontal, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { NotePropertyEntry, PropertyValue } from "../ipc/api";
import { useFeature } from "../lib/features";
import {
  coerceTo,
  effectiveKind,
  getKindHint,
  moveKindHint,
  PROPERTY_KINDS,
  setKindHint,
  type PropertyKind,
} from "../lib/propertyKinds";
import { useVault } from "../stores/vaultStore";
import { ChipInput } from "./ui/ChipInput";
import { Select } from "./ui/Select";
import { Switch } from "./ui/Switch";
import { TextField } from "./ui/TextField";

// Device-local "is the properties section expanded" bit (collapsed default).
const PROPS_OPEN_KEY = "nv:propsOpen";
function loadPropsOpen(): boolean {
  try {
    return localStorage.getItem(PROPS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
function savePropsOpen(open: boolean): void {
  try {
    localStorage.setItem(PROPS_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* ignore */
  }
}

// Mirror of the backend's creation-surface guard (notes/mod.rs RESERVED_KEYS)
// so the panel can show a localized message instead of a raw command error.
// The backend remains authoritative.
const RESERVED_KEYS = new Set(["title", "tags", "aliases", "created", "modified", "pinned"]);

// Static key map (i18next's typed keys reject dynamic template strings).
const KIND_LABEL_KEY = {
  text: "editor:propertyTypeText",
  number: "editor:propertyTypeNumber",
  date: "editor:propertyTypeDate",
  checkbox: "editor:propertyTypeCheckbox",
  list: "editor:propertyTypeList",
} as const;
// i18next-parser only scans static t() literals; these resolve at runtime via
// t(KIND_LABEL_KEY[kind]), so list them here to keep the catalog keys alive.
// t("editor:propertyTypeText")
// t("editor:propertyTypeNumber")
// t("editor:propertyTypeDate")
// t("editor:propertyTypeCheckbox")
// t("editor:propertyTypeList")

/** Collapsible typed editor for a note's custom frontmatter properties. The
 *  YAML stays the source of truth — every edit round-trips through the
 *  set/remove/rename commands and comes back via the refreshed note. */
export function PropertiesPanel({
  path,
  properties,
}: {
  path: string;
  properties: NotePropertyEntry[];
}) {
  const { t } = useTranslation(["editor", "common"]);
  const propertiesOn = useFeature("properties");
  const vaultPath = useVault((s) => s.vaultPath) ?? "";
  const setProperty = useVault((s) => s.setProperty);
  const removeProperty = useVault((s) => s.removeProperty);
  const renameProperty = useVault((s) => s.renameProperty);
  const [open, setOpen] = useState(loadPropsOpen);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  // Bumped when only a device-local kind hint changed (the note itself didn't),
  // so the affected row re-renders with its new widget.
  const [, setHintBump] = useState(0);

  // Leaving the note resets transient row state (the panel itself is shared
  // across notes via the open bit only).
  useEffect(() => {
    setMenuKey(null);
    setRenaming(null);
    setAdding(false);
    setKeyError(null);
  }, [path]);

  // Feature gate lives in the panel itself (not at the EditorPane mount).
  // After every hook so the hook order stays stable across a flag flip; the
  // frontmatter itself is untouched — re-enabling shows it again.
  if (!propertiesOn) return null;

  const toggleOpen = () =>
    setOpen((v) => {
      savePropsOpen(!v);
      return !v;
    });

  /** Localized client-side key validation; null = ok. */
  const keyProblem = (key: string, ignoreExisting?: string): string | null => {
    const k = key.trim();
    if (!k) return t("editor:propertyKeyEmpty");
    if (RESERVED_KEYS.has(k.toLowerCase())) return t("editor:propertyKeyReserved", { name: k });
    if (properties.some((p) => p.key === k && p.key !== ignoreExisting)) {
      return t("editor:propertyKeyExists", { name: k });
    }
    return null;
  };

  const commitRename = (from: string, to: string) => {
    const k = to.trim();
    if (k === from) {
      setRenaming(null);
      setKeyError(null);
      return;
    }
    // Validate BEFORE tearing the row down so an invalid name keeps the draft
    // editable next to the error (same stay-open behavior as the add row).
    const problem = keyProblem(k, from);
    if (problem) {
      setKeyError(problem);
      return;
    }
    setRenaming(null);
    setKeyError(null);
    moveKindHint(vaultPath, path, from, k); // the device-local kind follows
    void renameProperty(path, from, k);
  };

  /** Switch a property's kind: store the device-local hint and write the
   *  coerced value (if it changed). A value that can't be coerced shows a
   *  localized error and writes NOTHING — a lossy guess is worse than a no. */
  const commitKind = (entry: NotePropertyEntry, kind: PropertyKind) => {
    const coerced = coerceTo(entry.value, kind);
    if (coerced === null) {
      setKeyError(t("editor:propertyCoerceInvalid", { type: t(KIND_LABEL_KEY[kind]) }));
      return;
    }
    setKeyError(null);
    setKindHint(vaultPath, path, entry.key, kind);
    if (JSON.stringify(coerced) !== JSON.stringify(entry.value)) {
      void setProperty(path, entry.key, coerced);
    } else {
      // Same stored value (e.g. text ↔ date over a date-shaped string): only
      // the device-local hint changed — re-render for the new widget.
      setHintBump((n) => n + 1);
    }
  };

  const commitAdd = (key: string, value: string) => {
    const k = key.trim();
    const problem = keyProblem(k);
    if (problem) {
      setKeyError(problem);
      return;
    }
    setKeyError(null);
    setAdding(false);
    void setProperty(path, k, { kind: "text", value });
  };

  return (
    <div className="flex flex-col">
      <button
        onClick={toggleOpen}
        aria-expanded={open}
        className="flex items-center gap-1 self-start rounded px-0.5 text-[11px] uppercase tracking-wide text-fg-faint transition-colors hover:text-fg-muted"
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {t("editor:properties")}
        {properties.length > 0 && <span className="tabular-nums">({properties.length})</span>}
      </button>
      {open && (
        <div className="mt-1 flex flex-col gap-1">
          {properties.map((p) =>
            renaming === p.key ? (
              <RenameRow
                key={p.key}
                from={p.key}
                onCommit={(to) => commitRename(p.key, to)}
                onCancel={() => {
                  setRenaming(null);
                  setKeyError(null);
                }}
              />
            ) : (
              <PropertyRow
                key={p.key}
                entry={p}
                kind={effectiveKind(p.value, getKindHint(vaultPath, path, p.key))}
                onChangeKind={(kind) => commitKind(p, kind)}
                menuOpen={menuKey === p.key}
                onToggleMenu={() => setMenuKey((m) => (m === p.key ? null : p.key))}
                onRename={() => {
                  setMenuKey(null);
                  setKeyError(null);
                  setRenaming(p.key);
                }}
                onDelete={() => {
                  setMenuKey(null);
                  setKindHint(vaultPath, path, p.key, null); // hint dies with the key
                  void removeProperty(path, p.key);
                }}
                onCommit={(value) => void setProperty(path, p.key, value)}
              />
            ),
          )}
          {adding ? (
            <AddRow
              onCommit={commitAdd}
              onCancel={() => {
                setAdding(false);
                setKeyError(null);
              }}
            />
          ) : (
            <button
              onClick={() => {
                setKeyError(null);
                setAdding(true);
              }}
              className="flex items-center gap-1 self-start rounded px-0.5 py-0.5 text-xs text-fg-faint transition-colors hover:text-fg-muted"
            >
              <Plus size={12} />
              {t("editor:addProperty")}
            </button>
          )}
          {keyError && <p className="text-xs text-danger">{keyError}</p>}
        </div>
      )}
    </div>
  );
}

function PropertyRow({
  entry,
  kind,
  onChangeKind,
  menuOpen,
  onToggleMenu,
  onRename,
  onDelete,
  onCommit,
}: {
  entry: NotePropertyEntry;
  kind: PropertyKind;
  onChangeKind: (kind: PropertyKind) => void;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCommit: (value: PropertyValue) => void;
}) {
  const { t } = useTranslation(["editor", "common"]);
  return (
    <div className="flex items-center gap-2">
      <span
        title={entry.key}
        className="w-28 shrink-0 truncate text-xs text-fg-muted"
      >
        {entry.key}
      </span>
      <div className="flex min-w-0 flex-1 items-center">
        <ValueEditor kind={kind} value={entry.value} onCommit={onCommit} ariaLabel={entry.key} />
      </div>
      <Select
        value={kind}
        onChange={(v) => onChangeKind(v as PropertyKind)}
        options={PROPERTY_KINDS.map((k) => ({ value: k, label: t(KIND_LABEL_KEY[k]) }))}
        aria-label={t("editor:propertyType")}
        className="h-7 shrink-0 text-xs"
      />
      <div className="relative shrink-0">
        <button
          onClick={onToggleMenu}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={t("editor:propertyActions")}
          className="rounded-md p-1 text-fg-faint transition-colors hover:bg-active hover:text-fg"
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 z-10 mt-1 w-32 overflow-hidden rounded-lg border border-border-strong/80 bg-surface p-1 shadow-xl">
            <button
              onClick={onRename}
              className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-fg transition-colors hover:bg-hover"
            >
              {t("editor:renameProperty")}
            </button>
            <button
              onClick={onDelete}
              className="block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-danger transition-colors hover:bg-red-500/10"
            >
              {t("common:delete")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The kind-matched value widget (kind = inferred ∪ device-local override;
 *  `effectiveKind` guarantees it is compatible with the stored value). Text/
 *  number/date inputs draft and commit on blur or Enter (a per-keystroke
 *  commit would write the file on every key); switch and chips commit
 *  immediately (discrete actions). */
function ValueEditor({
  kind,
  value,
  onCommit,
  ariaLabel,
}: {
  kind: PropertyKind;
  value: PropertyValue;
  onCommit: (value: PropertyValue) => void;
  ariaLabel: string;
}) {
  switch (kind) {
    case "checkbox":
      return (
        <Switch
          checked={value.kind === "checkbox" && value.value}
          onChange={(v) => onCommit({ kind: "checkbox", value: v })}
          aria-label={ariaLabel}
        />
      );
    case "list":
      return (
        <ChipInput
          values={value.kind === "list" ? value.value : []}
          onChange={(next) => onCommit({ kind: "list", value: next })}
          ariaLabel={ariaLabel}
        />
      );
    case "number": {
      const current = value.kind === "number" && value.value != null ? String(value.value) : "";
      return (
        <DraftField
          key={current}
          type="number"
          initial={current}
          ariaLabel={ariaLabel}
          onCommit={(draft) => {
            const n = Number(draft);
            // Empty/garbage input never writes — declining makes the field
            // revert to the stored value.
            if (draft.trim() === "" || !Number.isFinite(n)) return false;
            onCommit({ kind: "number", value: n });
            return true;
          }}
        />
      );
    }
    case "date":
    case "text": {
      const current = value.kind === "text" ? value.value : "";
      return (
        <DraftField
          key={`${kind}:${current}`}
          type={kind}
          initial={current}
          ariaLabel={ariaLabel}
          onCommit={(draft) => {
            onCommit({ kind: "text", value: draft });
            return true;
          }}
        />
      );
    }
  }
}

/** Drafted input: edits local state, commits on blur (Enter blurs), Escape
 *  reverts. Drafting (vs controlled-commit-per-change) keeps file writes to
 *  one per edit — date segment typing would otherwise persist garbage
 *  intermediates and the async round-trip could snap the field back mid-edit.
 *  Keyed by the upstream value so an external change (another pane / on-disk
 *  edit) resets the draft. `onCommit` returning false declines the draft and
 *  the field reverts to the stored value. */
function DraftField({
  initial,
  type,
  onCommit,
  ariaLabel,
}: {
  initial: string;
  type: "text" | "number" | "date";
  onCommit: (draft: string) => boolean;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <TextField
      type={type}
      value={draft}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== initial && !onCommit(draft)) setDraft(initial);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          setDraft(initial);
          // Blur after the revert so no stale draft commits.
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
      }}
      className="h-7 min-w-0 flex-1 py-1 text-xs"
    />
  );
}

function RenameRow({
  from,
  onCommit,
  onCancel,
}: {
  from: string;
  onCommit: (to: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("editor");
  const [draft, setDraft] = useState(from);
  return (
    <div className="flex items-center gap-2">
      <TextField
        autoFocus
        value={draft}
        aria-label={t("propertyKey")}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="h-7 w-28 shrink-0 py-1 text-xs"
      />
      <span className="text-xs text-fg-faint">{t("renameProperty")}</span>
    </div>
  );
}

function AddRow({
  onCommit,
  onCancel,
}: {
  onCommit: (key: string, value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("editor");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const rowRef = useRef<HTMLDivElement>(null);
  const commit = () => {
    if (key.trim()) onCommit(key, value);
    else onCancel();
  };
  return (
    <div
      ref={rowRef}
      className="flex items-center gap-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
      onBlur={() => {
        // React blur events bubble: commit only once focus has left the WHOLE
        // row (tabbing from key → value must not commit half an entry).
        requestAnimationFrame(() => {
          if (rowRef.current && !rowRef.current.contains(document.activeElement)) commit();
        });
      }}
    >
      <TextField
        autoFocus
        value={key}
        placeholder={t("propertyKey")}
        aria-label={t("propertyKey")}
        onChange={(e) => setKey(e.target.value)}
        className="h-7 w-28 shrink-0 py-1 text-xs"
      />
      <TextField
        value={value}
        placeholder={t("propertyValue")}
        aria-label={t("propertyValue")}
        onChange={(e) => setValue(e.target.value)}
        className="h-7 min-w-0 flex-1 py-1 text-xs"
      />
    </div>
  );
}
