// Global last-resort error handlers. Uncaught window errors and unhandled
// promise rejections (every dropped `void somePromise()`) are routed into the
// shared error toast (vaultStore.reportError) instead of vanishing silently.
// Render errors are NOT handled here — the <ErrorBoundary> surfaces those.

import { useVault } from "../stores/vaultStore";

/** Identical messages inside this window are dropped, so a rejection loop
 *  (e.g. a failing interval) can't spam the toast. */
const DEDUPE_WINDOW_MS = 5_000;

let lastMessage: string | null = null;
let lastAt = 0;

function report(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  const now = Date.now();
  if (message === lastMessage && now - lastAt < DEDUPE_WINDOW_MS) return;
  lastMessage = message;
  lastAt = now;
  try {
    useVault.getState().reportError(e);
  } catch (storeErr) {
    // Never throw from a global handler (that would loop back into itself),
    // even if the store isn't usable yet — the console still has the original.
    console.error("global error handler could not reach the vault store:", storeErr);
  }
}

// Install-once flag lives on `window` (not module scope) so an HMR re-evaluation
// of this module can't stack a second pair of listeners.
const INSTALLED_FLAG = "__novalisGlobalErrorHandlers";

/** Register the window `error` / `unhandledrejection` listeners. Idempotent. */
export function installGlobalErrorHandlers(): void {
  const w = window as Window & { [INSTALLED_FLAG]?: boolean };
  if (w[INSTALLED_FLAG]) return;
  w[INSTALLED_FLAG] = true;
  window.addEventListener("error", (e) => {
    report(e.error ?? e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    report(e.reason);
  });
}
