// Reusable render-error boundary. Catches errors thrown during render /
// lifecycle of its subtree (including a lazy chunk failing to load inside a
// nested <Suspense>) and swaps in a compact fallback instead of white-screening
// the whole app. Two recovery modes: re-mount the children from scratch (the
// default, for per-view boundaries) or a full window reload (`reloadOnRetry`,
// for the app-root boundary where re-mounting can't help).
import { Component, Fragment, useState, type ErrorInfo, type ReactNode } from "react";

import { useTranslation } from "react-i18next";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Retry does a full `window.location.reload()` instead of re-mounting the
   *  children — for the app-root boundary. */
  reloadOnRetry?: boolean;
  /** Clears a caught error whenever any entry changes (e.g. the active view or
   *  the open PDF path) — otherwise a boundary that stays mounted across a
   *  view switch would keep showing the stale fallback. */
  resetKeys?: readonly unknown[];
  /** Extra classes on the fallback container (per-surface sizing/background). */
  className?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** React's component stack for the crash, kept for copy-diagnostics. */
  componentStack: string | null;
  /** Bumped on retry so the children re-mount from scratch (fresh state). */
  epoch: number;
}

/** The visible fallback — a function component so it can use hooks (the class
 *  itself can't call `useTranslation`). */
function ErrorFallback({
  error,
  componentStack,
  reload,
  onRetry,
  className,
}: {
  error: Error;
  componentStack: string | null;
  reload: boolean;
  onRetry: () => void;
  className?: string;
}) {
  const { t } = useTranslation("common");
  const [copied, setCopied] = useState(false);

  const copyDiagnostics = () => {
    const parts = [error.stack ?? `${error.name}: ${error.message}`];
    if (componentStack) parts.push(`Component stack:${componentStack}`);
    void navigator.clipboard
      ?.writeText(parts.join("\n\n"))
      .then(() => setCopied(true))
      .catch(() => {
        /* clipboard unavailable — the message is still visible on screen */
      });
  };

  return (
    <div
      role="alert"
      className={`flex flex-col items-center justify-center gap-3 p-6 text-center ${className ?? ""}`}
    >
      <p className="text-sm font-semibold text-fg">{t("errorBoundary.title")}</p>
      <p className="max-w-md break-words text-xs leading-relaxed text-fg-muted">
        {error.message}
      </p>
      <div className="flex gap-2">
        <button
          onClick={onRetry}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:opacity-90"
        >
          {reload ? t("errorBoundary.reload") : t("errorBoundary.retry")}
        </button>
        <button
          onClick={copyDiagnostics}
          className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          {copied ? t("errorBoundary.copied") : t("errorBoundary.copy")}
        </button>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: null, epoch: 0 };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Fail loud in the console (the fallback only shows the message).
    console.error("ErrorBoundary caught:", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    const { resetKeys } = this.props;
    if (!this.state.error || !resetKeys || !prev.resetKeys) return;
    const changed =
      resetKeys.length !== prev.resetKeys.length ||
      resetKeys.some((k, i) => !Object.is(k, prev.resetKeys?.[i]));
    if (changed) this.setState({ error: null, componentStack: null });
  }

  private retry = (): void => {
    if (this.props.reloadOnRetry) {
      window.location.reload();
      return;
    }
    this.setState((s) => ({ error: null, componentStack: null, epoch: s.epoch + 1 }));
  };

  render(): ReactNode {
    const { error, componentStack, epoch } = this.state;
    if (error) {
      return (
        <ErrorFallback
          error={error}
          componentStack={componentStack}
          reload={this.props.reloadOnRetry ?? false}
          onRetry={this.retry}
          className={this.props.className}
        />
      );
    }
    // Keyed by epoch so retry re-mounts the subtree with fresh state.
    return <Fragment key={epoch}>{this.props.children}</Fragment>;
  }
}
