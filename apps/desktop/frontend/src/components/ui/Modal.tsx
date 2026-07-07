import { useEffect, useRef, type ReactNode, type RefObject } from "react";

/** Selector for the elements a modal's Tab trap cycles through (matches the
 *  controls the app actually puts in dialogs; no visibility filtering). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Overlay + panel primitive shared by every modal shell: `role="dialog"`,
 *  `aria-modal`, Escape-to-close, a Tab/Shift+Tab focus trap, focus moved into
 *  the panel on mount (the panel itself unless `initialFocusRef` names a
 *  control) and restored to the trigger on unmount, and overlay-click close
 *  (`closeOnOverlayClick={false}` opts out).
 *
 *  Render it only while open (callers keep their `if (!open) return null`), so
 *  mount/unmount drives the focus bookkeeping. Escape/Tab are handled on the
 *  overlay with `stopPropagation`, which makes stacked dialogs (e.g. a
 *  ConfirmDialog inside TrashModal) layer correctly: only the innermost open
 *  dialog reacts. `useDismiss` is deliberately not reused here — its
 *  window-level Escape listener would close every dialog in a stack at once.
 *
 *  `label` is the already-localized accessible name. `overlayClassName`
 *  carries each modal's positioning/z-index (the base is
 *  `fixed inset-0 flex bg-overlay`); `panelClassName` is the full panel
 *  styling, since sizes diverge per modal. */
export function Modal({
  label,
  onClose,
  children,
  overlayClassName,
  panelClassName,
  initialFocusRef,
  closeOnOverlayClick = true,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  overlayClassName: string;
  panelClassName: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
  closeOnOverlayClick?: boolean;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Move focus into the dialog on open; hand it back to the trigger on close.
  // The restore is skipped when focus already moved elsewhere (e.g. the close
  // was caused by clicking a control outside the overlay).
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocusRef?.current ?? panelRef.current)?.focus();
    const overlay = overlayRef.current;
    return () => {
      if (!prev || prev === document.body || !prev.isConnected) return;
      const active = document.activeElement;
      if (active === null || active === document.body || (overlay?.contains(active) ?? false)) {
        prev.focus();
      }
    };
    // Mount-only: open/close is expressed by mounting/unmounting the Modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    // Always contain Tab so an outer dialog's trap never acts on this one.
    e.stopPropagation();
    const panel = panelRef.current;
    if (!panel) return;
    const els = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (els.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && els.includes(active);
    if (e.shiftKey) {
      if (!inside || active === els[0]) {
        e.preventDefault();
        els[els.length - 1].focus();
      }
    } else if (!inside || active === els[els.length - 1]) {
      e.preventDefault();
      els[0].focus();
    }
  };

  return (
    <div
      ref={overlayRef}
      className={`fixed inset-0 flex bg-overlay ${overlayClassName}`}
      onClick={closeOnOverlayClick ? onClose : undefined}
      onKeyDown={onKeyDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`outline-none ${panelClassName}`}
      >
        {children}
      </div>
    </div>
  );
}
