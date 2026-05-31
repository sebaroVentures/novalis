import type { ReactNode } from "react";

interface SettingsSectionProps {
  title?: string;
  description?: string;
  children: ReactNode;
}

export function SettingsSection({ title, description, children }: SettingsSectionProps) {
  return (
    <section className="mb-8 last:mb-0">
      {title && (
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
          {title}
        </h3>
      )}
      {description && <p className="mb-3 text-xs text-fg-faint">{description}</p>}
      <div>{children}</div>
    </section>
  );
}
