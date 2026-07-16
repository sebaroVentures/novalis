// @vitest-environment jsdom
//
// Behavior contract of the ErrorBoundary primitive: a throwing child renders
// the compact fallback (title + error message + actions) instead of unmounting
// the tree; retry re-mounts the children from scratch; a `resetKeys` change
// clears a caught error (the view-switch case); copy-diagnostics writes the
// stack to the clipboard. Raw createRoot + act — no testing-library dependency.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../../../lib/i18n";
import { ErrorBoundary } from "../ErrorBoundary";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

// Assert against the English catalog regardless of the host machine's locale.
beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  // Boundary catches log through console.error (React + componentDidCatch) —
  // silence the expected noise so real failures stay visible.
  vi.spyOn(console, "error").mockImplementation(() => {});
  defused = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const render = (ui: ReactNode) => act(async () => root.render(ui));

const alert = () => document.querySelector<HTMLElement>('[role="alert"]');

const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent === text);

// Module-level switch so retry can re-mount into a non-throwing render.
let defused = false;

function Bomb() {
  if (!defused) throw new Error("kaboom");
  return <p>recovered</p>;
}

function ChunkBomb(): ReactNode {
  throw new Error("Failed to fetch dynamically imported module: /assets/CanvasView.js");
}

describe("ErrorBoundary", () => {
  it("catches a throwing child and renders the fallback with the message", async () => {
    await render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    const el = alert();
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain("Something went wrong");
    expect(el!.textContent).toContain("kaboom");
    expect(buttonByText("Try again")).toBeDefined();
  });

  it("retry re-mounts the children", async () => {
    await render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(alert()).not.toBeNull();
    defused = true;
    await act(async () => buttonByText("Try again")!.click());
    expect(alert()).toBeNull();
    expect(container.textContent).toBe("recovered");
  });

  it("clears a caught error when a resetKeys entry changes (view switch)", async () => {
    await render(
      <ErrorBoundary resetKeys={["graph"]}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(alert()).not.toBeNull();
    defused = true;
    await render(
      <ErrorBoundary resetKeys={["canvas"]}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(alert()).toBeNull();
    expect(container.textContent).toBe("recovered");
  });

  it("offers a full reload instead of retry in reloadOnRetry mode", async () => {
    await render(
      <ErrorBoundary reloadOnRetry>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(buttonByText("Reload app")).toBeDefined();
    expect(buttonByText("Try again")).toBeUndefined();
  });

  it("forces a full reload for a failed lazy-chunk load (re-mount would rethrow)", async () => {
    await render(
      <ErrorBoundary>
        <ChunkBomb />
      </ErrorBoundary>,
    );
    // A per-view boundary would normally offer "Try again", but a rejected
    // React.lazy payload can only be recovered by reloading, so the label flips.
    expect(buttonByText("Reload app")).toBeDefined();
    expect(buttonByText("Try again")).toBeUndefined();
  });

  it("shows a Close action and honours Escape when onDismiss is set", async () => {
    const onDismiss = vi.fn();
    await render(
      <ErrorBoundary onDismiss={onDismiss}>
        <Bomb />
      </ErrorBoundary>,
    );
    const close = buttonByText("Close");
    expect(close).toBeDefined();
    await act(async () => close!.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });

  it("copies diagnostics (stack) to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    await act(async () => buttonByText("Copy diagnostics")!.click());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("kaboom");
    expect(buttonByText("Copied")).toBeDefined();
  });
});
