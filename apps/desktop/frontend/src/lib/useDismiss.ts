import { useEffect, useRef, type RefObject } from "react";

/** Dismiss an open popover/menu on outside mousedown or Escape. Listeners are
 *  attached only while `isOpen` and torn down on close/unmount, so a click that
 *  opens the menu can't immediately re-close it. `onClose` need not be memoized
 *  — the latest one is always called. Pass `closeOnResize` for viewport-anchored
 *  popups that a window resize would misplace. */
export function useDismiss<T extends HTMLElement>(
  ref: RefObject<T | null>,
  isOpen: boolean,
  onClose: () => void,
  options?: { closeOnResize?: boolean },
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeOnResize = options?.closeOnResize ?? false;

  useEffect(() => {
    if (!isOpen) return;
    const close = () => onCloseRef.current();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    if (closeOnResize) window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      if (closeOnResize) window.removeEventListener("resize", close);
    };
  }, [ref, isOpen, closeOnResize]);
}
