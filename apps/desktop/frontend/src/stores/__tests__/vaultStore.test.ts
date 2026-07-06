// handleExternalChange must never clean-adopt disk content over a pane that
// holds unflushed edits. The per-path save state turns "dirty" only after the
// editor's serialize debounce, so a watcher `note-changed` landing inside that
// window has to consult the flush registry (PaneFlush.pendingPath) — otherwise
// the last debounce window of typing is silently discarded (the OneDrive-vault
// data-loss case).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getNote: vi.fn() }));

vi.mock("../../ipc/api", () => ({
  api: { getNote: mocks.getNote },
  NovalisError: class NovalisError extends Error {
    kind: string;
    constructor(err: { kind: string; message: string }) {
      super(err.message);
      this.kind = err.kind;
    }
  },
}));

import type { Note } from "../../ipc/api";
import { useUi } from "../uiStore";
import { useVault, type PaneFlush } from "../vaultStore";

function diskNote(path: string, content: string): Note {
  return { path, title: path, content, frontmatter: {}, wordCount: 0 };
}

/** Point the workspace's single pane at `path` so the note counts as visible. */
function showInPane(path: string): void {
  useUi.setState({
    workspace: {
      panes: [{ id: "main", tabs: [path], activeTab: path }],
      focusedPaneId: "main",
      direction: "row",
    },
  });
}

function paneEntry(pendingPath: string | null): PaneFlush {
  return { flush: async () => {}, pendingPath: () => pendingPath, discard: () => {} };
}

describe("vaultStore.handleExternalChange", () => {
  beforeEach(() => {
    mocks.getNote.mockReset();
    useVault.setState({
      openNotes: new Map(),
      paneEpochs: new Map(),
      saveStates: new Map(),
      saveErrors: new Map(),
      externalChange: null,
    });
  });

  afterEach(() => {
    // The flush registry is module-level state — always unregister the pane.
    useVault.getState().registerFlush("main", null);
  });

  it("prompts (no adopt, no remount) when a pane holds live edits the debounce has not surfaced", async () => {
    // Save state is NOT dirty yet — markDirty only fires after the editor's
    // serialize debounce — but the pane reports an unflushed edit.
    showInPane("live.md");
    useVault.getState().registerFlush("main", paneEntry("live.md"));
    mocks.getNote.mockResolvedValue(diskNote("live.md", "external content"));

    await useVault.getState().handleExternalChange("live.md");

    const s = useVault.getState();
    expect(s.externalChange).toBe("live.md");
    expect(s.openNotes.has("live.md")).toBe(false); // disk content NOT adopted
    expect(s.paneEpochs.get("main")).toBeUndefined(); // typing pane NOT remounted
  });

  it("prompts when the per-path save state is dirty", async () => {
    showInPane("dirty.md");
    useVault.getState().markDirty("dirty.md");
    mocks.getNote.mockResolvedValue(diskNote("dirty.md", "external content"));

    await useVault.getState().handleExternalChange("dirty.md");

    const s = useVault.getState();
    expect(s.externalChange).toBe("dirty.md");
    expect(s.openNotes.has("dirty.md")).toBe(false);
  });

  it("adopts disk content and remounts the pane when it is clean", async () => {
    showInPane("clean.md");
    useVault.getState().registerFlush("main", paneEntry(null));
    mocks.getNote.mockResolvedValue(diskNote("clean.md", "external content"));

    await useVault.getState().handleExternalChange("clean.md");

    const s = useVault.getState();
    expect(s.externalChange).toBeNull();
    expect(s.openNotes.get("clean.md")?.content).toBe("external content");
    expect(s.paneEpochs.get("main")).toBe(1); // remounted with the adopted content
    expect(s.saveStates.get("clean.md")).toBe("idle");
  });

  it("ignores our own write echo even while the pane is typing again", async () => {
    // First event: clean adopt caches the disk content.
    showInPane("echo.md");
    mocks.getNote.mockResolvedValue(diskNote("echo.md", "same content"));
    await useVault.getState().handleExternalChange("echo.md");
    expect(useVault.getState().paneEpochs.get("main")).toBe(1);

    // Second event carries identical disk content (the watcher echoing a
    // write): the echo check must win over the live-edit conflict path.
    useVault.getState().registerFlush("main", paneEntry("echo.md"));
    await useVault.getState().handleExternalChange("echo.md");

    const s = useVault.getState();
    expect(s.externalChange).toBeNull();
    expect(s.paneEpochs.get("main")).toBe(1); // no second remount
  });
});
