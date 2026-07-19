// The AI master/sub nesting lives in exactly one place (featureOn): an AI
// sub-feature is active only when BOTH the `ai` master and its own flag are
// true, while non-AI flags stand alone. The ipc module is mocked so no Tauri
// runtime is needed.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/api", () => ({
  api: { getPreferences: vi.fn(), setPreferences: vi.fn() },
}));

import { featureOn } from "../features";

describe("featureOn", () => {
  it("resolves serde defaults when the block is missing (pre-load / legacy vault)", () => {
    expect(featureOn(undefined, "tasks")).toBe(true);
    expect(featureOn(undefined, "outline")).toBe(true);
    expect(featureOn(undefined, "canvas")).toBe(false);
    expect(featureOn(undefined, "graphView")).toBe(false);
  });

  it("gates AI sub-features behind the master switch", () => {
    // Subs default on, but the master defaults off — effectively off.
    expect(featureOn(undefined, "vaultChat")).toBe(false);
    expect(featureOn({ ai: true }, "vaultChat")).toBe(true);
    expect(featureOn({ ai: true, vaultChat: false }, "vaultChat")).toBe(false);
    expect(featureOn({ ai: false, vaultChat: true }, "vaultChat")).toBe(false);
    // The token-costing entity graph stays opt-in even under an enabled master.
    expect(featureOn({ ai: true }, "entityGraph")).toBe(false);
    expect(featureOn({ ai: true, entityGraph: true }, "entityGraph")).toBe(true);
  });

  it("leaves non-AI flags independent of the master", () => {
    expect(featureOn({ ai: false, canvas: true }, "canvas")).toBe(true);
    expect(featureOn({ ai: true, outline: false }, "outline")).toBe(false);
  });
});
