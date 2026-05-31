interface ColorSwatchPickerProps {
  value: string;
  onChange: (token: string) => void;
  colors: Record<string, string>;
}

export function ColorSwatchPicker({ value, onChange, colors }: ColorSwatchPickerProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {Object.entries(colors).map(([token, hex]) => {
        const active = token === value;
        return (
          <button
            key={token}
            type="button"
            title={token}
            aria-label={token}
            aria-pressed={active}
            onClick={() => onChange(token)}
            style={{ background: hex }}
            className={`h-6 w-6 rounded-full transition-transform hover:scale-110 ${
              active ? "ring-2 ring-fg ring-offset-2 ring-offset-surface" : ""
            }`}
          />
        );
      })}
    </div>
  );
}
