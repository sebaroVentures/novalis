import { create } from "zustand";

import { api, NovalisError, type FolderNode, type Note } from "../ipc/api";

interface VaultState {
  vaultPath: string | null;
  tree: FolderNode | null;
  activePath: string | null;
  activeNote: Note | null;
  loading: boolean;
  error: string | null;

  /** Sync UI state with whatever vault the backend currently has open. */
  sync: () => Promise<void>;
  pickAndOpen: () => Promise<void>;
  openVault: (path: string) => Promise<void>;
  refreshTree: () => Promise<void>;
  openNote: (path: string) => Promise<void>;
  newNote: (folder: string, templateId?: string) => Promise<void>;
  deleteActive: () => Promise<void>;
  saveNote: (path: string, content: string) => Promise<void>;
  clearError: () => void;
}

export const useVault = create<VaultState>((set, get) => ({
  vaultPath: null,
  tree: null,
  activePath: null,
  activeNote: null,
  loading: true,
  error: null,

  sync: async () => {
    try {
      const vaultPath = await api.currentVault();
      set({ vaultPath, loading: false });
      if (vaultPath) await get().refreshTree();
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  pickAndOpen: async () => {
    const path = await api.pickVaultFolder();
    if (path) await get().openVault(path);
  },

  openVault: async (path) => {
    set({ loading: true, error: null });
    try {
      await api.openVault(path);
      set({ vaultPath: path, loading: false, activePath: null, activeNote: null });
      await get().refreshTree();
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  refreshTree: async () => {
    try {
      set({ tree: await api.getFolderTree() });
    } catch (e) {
      // A noVault error here just means the engine isn't ready yet.
      if (!(e instanceof NovalisError && e.kind === "noVault")) {
        set({ error: String(e) });
      }
    }
  },

  openNote: async (path) => {
    try {
      const note = await api.getNote(path);
      set({ activePath: path, activeNote: note });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  newNote: async (folder, templateId) => {
    const base = folder ? `${folder}/` : "";
    for (let i = 1; i <= 50; i++) {
      const name = i === 1 ? "Untitled" : `Untitled ${i}`;
      try {
        const note = await api.createNote(
          `${base}${name}.md`,
          templateId ? { template: templateId } : undefined,
        );
        await get().refreshTree();
        set({ activePath: note.path, activeNote: note });
        return;
      } catch (e) {
        if (e instanceof NovalisError && e.kind === "alreadyExists") continue;
        set({ error: String(e) });
        return;
      }
    }
  },

  deleteActive: async () => {
    const path = get().activePath;
    if (!path) return;
    try {
      await api.deleteNote(path);
      set({ activePath: null, activeNote: null });
      await get().refreshTree();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  saveNote: async (path, content) => {
    try {
      await api.updateNote(path, content);
      await get().refreshTree();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  clearError: () => set({ error: null }),
}));
