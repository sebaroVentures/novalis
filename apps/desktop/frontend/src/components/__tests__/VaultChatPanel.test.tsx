// @vitest-environment jsdom
//
// A11y contract of the vault-chat panel: it exposes a labelled complementary
// region, moves initial focus onto the question box when opened, and closes on
// Escape from inside the panel.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// aiStore reads localStorage at module-eval time; Node exposes it as a
// getter-only accessor that is undefined here, so stub it before the import.
vi.hoisted(() => {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
      key: () => null,
      length: 0,
    },
    configurable: true,
  });
});

import i18n from "../../lib/i18n";
import type { AiConnectionView } from "../../ipc/api";
import { useAi } from "../../stores/aiStore";
import { useVaultChat } from "../../stores/vaultChatStore";
import { VaultChatPanel } from "../VaultChatPanel";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom leaves Element.prototype.scrollTo undefined; the panel auto-scrolls its
// answer into view on mount.
if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};

const connection: AiConnectionView = {
  id: "c1",
  kind: "anthropic",
  label: "Claude",
  baseUrl: null,
  model: "claude",
  enabled: true,
  agentic: false,
  configured: true,
  available: true,
  models: [],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  // Seed a usable connection and mark AI loaded so the panel's lazy load() (a
  // Tauri call) never fires.
  useAi.setState({ connections: [connection], loaded: true, selectedConnectionId: "c1" });
  useVaultChat.setState({
    open: true,
    status: "idle",
    question: "",
    answer: "",
    citations: [],
    error: null,
    requestId: "",
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useVaultChat.setState({ open: false });
});

describe("VaultChatPanel", () => {
  it("renders a labelled complementary region and focuses the question box", async () => {
    await act(async () => root.render(<VaultChatPanel />));

    const region = document.querySelector<HTMLElement>('[role="complementary"]');
    expect(region).not.toBeNull();
    expect(region!.getAttribute("aria-label")).toBe(i18n.t("chat.title", { ns: "ai" }));

    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    expect(document.activeElement).toBe(textarea);
  });

  it("closes on Escape from inside the panel", async () => {
    await act(async () => root.render(<VaultChatPanel />));
    const textarea = container.querySelector("textarea")!;
    act(() => textarea.focus());

    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });

    expect(useVaultChat.getState().open).toBe(false);
    expect(document.querySelector('[role="complementary"]')).toBeNull();
  });
});
