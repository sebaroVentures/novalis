import type { InputHTMLAttributes } from "react";

export function TextField({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-fg outline-none ring-1 ring-transparent transition placeholder:text-fg-faint focus:ring-accent/50 ${className}`}
    />
  );
}
