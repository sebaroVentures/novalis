// @vitest-environment jsdom
//
// Canvas gallery UX contract: cards are reachable and activatable by keyboard
// (role=button + tabIndex + Enter opens the canvas), and a failed delete never
// fails silently — it routes into vaultStore's global error surface (the
// App.tsx toast). The ipc module is mocked; raw createRoot + act, no
// testing-library dependency (mirrors ContextMenu.test / ErrorBoundary.test).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCanvases: vi.fn(),
  deleteCanvas: vi.fn(),
  readCanvas: vi.fn(),
  writeCanvas: vi.fn(),
  createCanvas: vi.fn(),
  getNote: vi.fn(),
  listNotes: vi.fn(),
}));

vi.mock("../../ipc/api", () => ({
  api: { ...mocks },
}));

import i18n from "../../lib/i18n";
import { emptyCanvas, serializeCanvas } from "../../lib/canvas";
import CanvasView from "../CanvasView";
import { useCanvas } from "../../stores/canvasStore";
import { useVault } from "../../stores/vaultStore";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readCanvas.mockResolvedValue(serializeCanvas(emptyCanvas()));
  mocks.writeCanvas.mockResolvedValue(null);
  mocks.listNotes.mockResolvedValue([]);
  useCanvas.setState({ activeCanvas: null });
  useCanvas.getState().setFlushHandler(null);
  useVault.setState({ error: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const flush = () => act(async () => {});

const galleryCard = () => document.querySelector<HTMLDivElement>('[role="button"]');

describe("CanvasGallery keyboard activation", () => {
  it("opens the focused card when Enter is pressed", async () => {
    mocks.listCanvases.mockResolvedValue([{ name: "Board", path: "Board.canvas" }]);

    await act(async () => root.render(<CanvasView />));
    await flush(); // let listCanvases resolve and paint the grid

    const card = galleryCard();
    expect(card).not.toBeNull();
    // Real button semantics: role + reachable in the tab order.
    expect(card!.getAttribute("role")).toBe("button");
    expect(card!.tabIndex).toBe(0);

    card!.focus();
    expect(document.activeElement).toBe(card);

    await act(async () => {
      card!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    await flush();

    expect(useCanvas.getState().activeCanvas).toBe("Board.canvas");
  });
});

describe("CanvasGallery delete failure", () => {
  it("surfaces a failed delete globally instead of swallowing it", async () => {
    mocks.listCanvases.mockResolvedValue([{ name: "Board", path: "Board.canvas" }]);
    mocks.deleteCanvas.mockRejectedValue(new Error("io error"));

    await act(async () => root.render(<CanvasView />));
    await flush();

    // Open the confirm dialog via the card's delete affordance …
    const del = document.querySelector<HTMLButtonElement>(
      `button[title="${i18n.t("common:canvas.deleteCanvas")}"]`,
    );
    expect(del).not.toBeNull();
    await act(async () => del!.click());

    // … then confirm (the danger-styled button in ConfirmDialog).
    const confirm = document.querySelector<HTMLButtonElement>("button.bg-danger");
    expect(confirm).not.toBeNull();
    await act(async () => confirm!.click());
    await flush();

    expect(useVault.getState().error).toContain("io error");
    // Still in the gallery — the failed delete didn't pretend to succeed.
    expect(useCanvas.getState().activeCanvas).toBeNull();
  });
});
