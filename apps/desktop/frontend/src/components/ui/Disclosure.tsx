import { useState, type ReactNode } from "react";

import { ChevronDown, ChevronRight } from "lucide-react";

interface DisclosureProps {
  /** Already-translated button label. */
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}

/** Minimal accessible expander: a chevron + label button row that toggles its
 *  children. Styled to sit inside the SettingsSection/SettingRow visual
 *  language (small, subtle, no borders of its own). */
export function Disclosure({ label, children, defaultOpen = false }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded px-0.5 text-xs font-medium text-fg-subtle transition-colors hover:text-fg"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}
