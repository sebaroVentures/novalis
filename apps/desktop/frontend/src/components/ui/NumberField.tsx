interface NumberFieldProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  id?: string;
}

export function NumberField({ value, onChange, min, max, step = 1, suffix, id }: NumberFieldProps) {
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(clamp(n));
        }}
        className="w-20 rounded-lg bg-surface-2 px-2.5 py-1.5 text-sm text-fg outline-none ring-1 ring-transparent transition focus:ring-accent/50"
      />
      {suffix && <span className="text-xs text-fg-subtle">{suffix}</span>}
    </div>
  );
}
