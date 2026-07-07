// @vitest-environment jsdom
//
// Keyboard model of the context menu: focus lands on the first enabled item on
// open, ArrowUp/Down cycle (skipping disabled items), Home/End jump to the
// edges, and focus returns to the invoker on close.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContextMenu, type MenuItem } from "../ContextMenu";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const press = (key: string) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });

const items: MenuItem[] = [
  { label: "alpha", onClick: () => {} },
  { label: "beta", onClick: () => {}, disabled: true },
  { label: "gamma", onClick: () => {} },
];

describe("ContextMenu keyboard navigation", () => {
  it("focuses the first item on open and cycles with arrows, Home and End", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    await act(async () =>
      root.render(<ContextMenu x={10} y={10} items={items} onClose={() => {}} />),
    );
    const [alpha, , gamma] = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    );
    // Focus moved off the invoker onto the first enabled item.
    expect(document.activeElement).toBe(alpha);

    await press("ArrowDown"); // skips the disabled "beta"
    expect(document.activeElement).toBe(gamma);
    await press("ArrowDown"); // wraps
    expect(document.activeElement).toBe(alpha);
    await press("ArrowUp"); // wraps backward
    expect(document.activeElement).toBe(gamma);
    await press("Home");
    expect(document.activeElement).toBe(alpha);
    await press("End");
    expect(document.activeElement).toBe(gamma);

    // Closing (unmount) hands focus back to the invoker.
    await act(async () => root.render(null));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});
