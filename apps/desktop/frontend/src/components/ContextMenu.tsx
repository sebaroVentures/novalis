import { useLayoutEffect, useRef, useState } from "react";

import { useDismiss } from "../lib/useDismiss";

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a thin divider above this item. */
  separatorBefore?: boolean;
}

/** Cursor-positioned popup menu. Follows the NewNoteButton dropdown styling and
 *  closes on outside mousedown / Escape / scroll. Position is clamped to the
 *  viewport so it never overflows the window edge. */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - width - 8),
      y: Math.min(y, window.innerHeight - height - 8),
    });
  }, [x, y]);

  useDismiss(ref, true, onClose, { closeOnResize: true });

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 w-48 overflow-hidden rounded-lg border border-border-strong/80 bg-surface p-1 shadow-xl"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.separatorBefore && <div className="my-1 border-t border-border" />}
          <button
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onClick();
            }}
            className={`block w-full truncate rounded-md px-2.5 py-1.5 text-left text-xs transition-colors disabled:opacity-40 ${
              item.danger
                ? "text-danger hover:bg-red-500/10"
                : "text-fg hover:bg-hover"
            }`}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
