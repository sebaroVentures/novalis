// @vitest-environment jsdom
//
// A11y contract of the full-screen PDF viewer: it mounts as a modal dialog that
// moves initial focus onto a control and traps Tab within the overlay (both via
// the shared Modal shell). pdf.js and its worker are mocked — the document never
// loads here (no vault path), so the viewer stays in its loading state and we
// exercise only the focus/trap wiring around the toolbar.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: vi.fn(() => ({ promise: new Promise(() => {}), destroy: vi.fn() })),
  TextLayer: class {
    render() {
      return Promise.resolve();
    }
  },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "worker.js" }));
vi.mock("../../ipc/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ipc/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      readPdfAnnotations: vi.fn().mockResolvedValue({ version: 1, highlights: [] }),
    },
  };
});

import i18n from "../../lib/i18n";
import { usePdf } from "../../stores/pdfStore";
import PdfViewer from "../PdfViewer";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  usePdf.setState({ path: "docs/a.pdf", focusHighlightId: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  usePdf.setState({ path: null });
});

const press = (key: string, opts: KeyboardEventInit = {}) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }),
    );
  });

describe("PdfViewer focus trap", () => {
  it("mounts as a dialog, focuses a control, and wraps Tab within the overlay", async () => {
    await act(async () => root.render(<PdfViewer />));

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-modal")).toBe("true");

    // Initial focus landed on the close button (Modal's initialFocusRef).
    const closeBtn = dialog!.querySelector<HTMLButtonElement>(
      `button[title="${i18n.t("viewer.close", { ns: "pdf" })}"]`,
    )!;
    expect(document.activeElement).toBe(closeBtn);

    const buttons = Array.from(dialog!.querySelectorAll<HTMLButtonElement>("button"));
    const first = buttons[0];
    const last = buttons[buttons.length - 1];

    // Tab from the last focusable wraps to the first; Shift+Tab wraps back.
    act(() => last.focus());
    await press("Tab");
    expect(document.activeElement).toBe(first);
    await press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
