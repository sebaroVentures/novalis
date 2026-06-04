import { type ReactNode, useId, useMemo, useState } from "react";

import { X } from "lucide-react";

export interface ChipInputProps {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Optional autocomplete source (already-known values). */
  suggestions?: string[];
  ariaLabel?: string;
  /** Render a chip's body (e.g. a leading `#`). Defaults to the raw value. */
  renderChip?: (value: string) => ReactNode;
}

/** A compact tag/alias chip editor: add on Enter/comma, remove via a chip's ×
 *  or Backspace on an empty input, with an optional suggestion dropdown.
 *  Controlled — the parent owns `values`. */
export function ChipInput({
  values,
  onChange,
  placeholder,
  suggestions = [],
  ariaLabel,
  renderChip,
}: ChipInputProps) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const listId = useId();

  const add = (raw: string) => {
    const v = raw.trim().replace(/^#+/, "");
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase())) {
      onChange([...values, v]);
    }
    setDraft("");
    setOpen(false);
  };

  const removeAt = (i: number) => onChange(values.filter((_, j) => j !== i));

  const matches = useMemo(() => {
    const q = draft.trim().toLowerCase();
    return suggestions
      .filter((s) => !values.some((v) => v.toLowerCase() === s.toLowerCase()))
      .filter((s) => (q ? s.toLowerCase().includes(q) : true))
      .slice(0, 8);
  }, [draft, suggestions, values]);

  return (
    <div className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1 rounded-lg bg-surface-2 px-2 py-1 ring-1 ring-transparent focus-within:ring-accent/50">
      {values.map((v, i) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded-md bg-active px-1.5 py-0.5 text-xs text-fg"
        >
          {renderChip ? renderChip(v) : v}
          <button
            type="button"
            aria-label={`remove ${v}`}
            onClick={() => removeAt(i)}
            className="text-fg-faint transition-colors hover:text-fg"
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        aria-label={ariaLabel}
        aria-controls={open ? listId : undefined}
        placeholder={values.length === 0 ? placeholder : ""}
        onChange={(e) => {
          setDraft(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Delay close so a suggestion mousedown still registers.
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(draft);
          } else if (e.key === "Backspace" && !draft && values.length) {
            removeAt(values.length - 1);
          }
        }}
        className="min-w-[6rem] flex-1 bg-transparent py-0.5 text-xs text-fg outline-none placeholder:text-fg-faint"
      />
      {open && matches.length > 0 && (
        <ul
          id={listId}
          className="absolute left-0 top-full z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-xl"
        >
          {matches.map((s) => (
            <li key={s}>
              <button
                type="button"
                onMouseDown={(e) => {
                  // mousedown (not click) so it fires before the input blur closes the list.
                  e.preventDefault();
                  add(s);
                }}
                className="block w-full rounded-md px-2 py-1 text-left text-xs text-fg transition-colors hover:bg-hover"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
