import type { ReactNode } from "react";

interface SettingRowProps {
  label: string;
  description?: string;
  control: ReactNode;
  htmlFor?: string;
}

export function SettingRow({ label, description, control, htmlFor }: SettingRowProps) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-border/60 py-3 last:border-0">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm text-fg">
          {label}
        </label>
        {description && <p className="mt-0.5 text-xs text-fg-subtle">{description}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
