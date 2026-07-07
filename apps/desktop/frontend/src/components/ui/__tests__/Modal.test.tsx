// @vitest-environment jsdom
//
// Behavior contract of the Modal primitive: dialog semantics, Escape-to-close,
// the Tab focus trap, focus moved into the dialog on open (default panel or
// `initialFocusRef`), focus restored to the trigger on close, and
// overlay-click close (plus its opt-out). Raw createRoot + act — no
// testing-library dependency.
import { act, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Modal } from "../Modal";

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

const render = (ui: ReactNode) => act(async () => root.render(ui));

const press = (key: string, opts: KeyboardEventInit = {}) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }),
    );
  });

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

function TwoButtons({
  onClose,
  closeOnOverlayClick,
}: {
  onClose: () => void;
  closeOnOverlayClick?: boolean;
}) {
  return (
    <Modal
      label="Test dialog"
      onClose={onClose}
      overlayClassName="z-50"
      panelClassName="p-4"
      closeOnOverlayClick={closeOnOverlayClick}
    >
      <button>first</button>
      <button>last</button>
    </Modal>
  );
}

function WithInitialFocus({ onClose }: { onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <Modal
      label="Test dialog"
      onClose={onClose}
      initialFocusRef={inputRef}
      overlayClassName="z-50"
      panelClassName="p-4"
    >
      <input ref={inputRef} />
    </Modal>
  );
}

describe("Modal", () => {
  it("renders dialog semantics and focuses the panel by default", async () => {
    await render(<TwoButtons onClose={() => {}} />);
    const el = dialog();
    expect(el).not.toBeNull();
    expect(el!.getAttribute("aria-modal")).toBe("true");
    expect(el!.getAttribute("aria-label")).toBe("Test dialog");
    expect(document.activeElement).toBe(el);
  });

  it("focuses the initialFocusRef element on open", async () => {
    await render(<WithInitialFocus onClose={() => {}} />);
    expect(document.activeElement).toBe(document.querySelector("input"));
  });

  it("closes on Escape from anywhere inside", async () => {
    const onClose = vi.fn();
    await render(<TwoButtons onClose={onClose} />);
    const [first] = Array.from(document.querySelectorAll("button"));
    act(() => first.focus());
    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("traps Tab: wraps forward from the last and backward from the first element", async () => {
    await render(<TwoButtons onClose={() => {}} />);
    const [first, last] = Array.from(document.querySelectorAll("button"));
    act(() => last.focus());
    await press("Tab");
    expect(document.activeElement).toBe(first);
    await press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("restores focus to the trigger on close", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    await render(<TwoButtons onClose={() => {}} />);
    expect(document.activeElement).not.toBe(trigger);
    await render(null);
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("closes on overlay click but not on panel click, honoring the opt-out", async () => {
    const onClose = vi.fn();
    await render(<TwoButtons onClose={onClose} />);
    await act(async () => dialog()!.click());
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => (dialog()!.parentElement as HTMLElement).click());
    expect(onClose).toHaveBeenCalledTimes(1);

    const onClose2 = vi.fn();
    await render(<TwoButtons onClose={onClose2} closeOnOverlayClick={false} />);
    await act(async () => (dialog()!.parentElement as HTMLElement).click());
    expect(onClose2).not.toHaveBeenCalled();
  });
});
