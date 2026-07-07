import { useEffect, useLayoutEffect, useRef, useState } from "react";

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
 *  viewport so it never overflows the window edge. Keyboard: focus lands on the
 *  first item on open, ArrowUp/Down cycle (skipping disabled items), Home/End
 *  jump, Enter/Space activate the focused item natively, and focus returns to
 *  the invoker on close. */
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

  const enabledItems = () =>
    Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [],
    );

  // Move focus to the first item on open; hand it back to the invoker on close
  // — unless the close came from clicking a control elsewhere (focus already
  // moved on mousedown), in which case the click's target keeps it.
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    enabledItems()[0]?.focus();
    return () => {
      if (!prev || prev === document.body || !prev.isConnected) return;
      const active = document.activeElement;
      if (active === null || active === document.body || (el?.contains(active) ?? false)) {
        prev.focus();
      }
    };
    // Mount-only: the menu unmounts to close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    e.stopPropagation();
    const els = enabledItems();
    if (els.length === 0) return;
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home"
        ? els[0]
        : e.key === "End"
          ? els[els.length - 1]
          : e.key === "ArrowDown"
            ? els[(i + 1) % els.length]
            : els[i <= 0 ? els.length - 1 : i - 1];
    next.focus();
  };

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 w-48 overflow-hidden rounded-lg border border-border-strong/80 bg-surface p-1 shadow-xl"
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
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
