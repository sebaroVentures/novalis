import { create } from "zustand";

import { emptyCanvas, serializeCanvas } from "../lib/canvas";
import { api, type CanvasFile } from "../ipc/api";
import { useUi } from "./uiStore";
import { useVault } from "./vaultStore";

/** Vault-relative path of the folder to create a new canvas in, given the
 *  sidebar's current selection. Empty string = vault root. */
function targetFolder(): string {
  return useVault.getState().selectedFolder ?? "";
}

/** Find a free `Untitled Canvas[ N].canvas` path within `folder`, avoiding any
 *  existing canvas file. */
function freshCanvasPath(existing: CanvasFile[], folder: string): string {
  const taken = new Set(existing.map((c) => c.path));
  const dir = folder ? `${folder}/` : "";
  const base = "Untitled Canvas";
  for (let i = 0; i < 1000; i++) {
    const name = i === 0 ? base : `${base} ${i + 1}`;
    const path = `${dir}${name}.canvas`;
    if (!taken.has(path)) return path;
  }
  // Effectively unreachable; fall back to a timestamped name.
  return `${dir}${base} ${Date.now()}.canvas`;
}

interface CanvasState {
  /** Vault-relative path of the open canvas, or null to show the gallery. */
  activeCanvas: string | null;
  /** Open a canvas by path and switch to the canvas view. */
  openCanvas: (path: string) => void;
  /** Return to the canvas gallery (keeps the canvas view active). */
  closeCanvas: () => void;
  /** Create a fresh empty canvas in the selected folder and open it. */
  createAndOpen: () => Promise<void>;
}

export const useCanvas = create<CanvasState>((set) => ({
  activeCanvas: null,

  openCanvas: (path) => {
    set({ activeCanvas: path });
    useUi.getState().setView("canvas");
  },

  closeCanvas: () => set({ activeCanvas: null }),

  createAndOpen: async () => {
    const existing = await api.listCanvases().catch(() => []);
    const path = freshCanvasPath(existing, targetFolder());
    await api.createCanvas(path, serializeCanvas(emptyCanvas()));
    set({ activeCanvas: path });
    useUi.getState().setView("canvas");
  },
}));
