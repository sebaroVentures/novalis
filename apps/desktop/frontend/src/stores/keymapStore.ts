import { create } from "zustand";

import {
  type ActionId,
  type Chord,
  loadKeymap,
  resetKeymap,
  setKeybinding,
} from "../lib/keybindings";

interface KeymapState {
  keymap: Record<ActionId, Chord>;
  /** Set (or, with null, reset) one action's chord and refresh the map. */
  rebind: (action: ActionId, chord: Chord | null) => void;
  /** Reset every shortcut to its default. */
  reset: () => void;
}

export const useKeymap = create<KeymapState>((set) => ({
  keymap: loadKeymap(),
  rebind: (action, chord) => {
    setKeybinding(action, chord);
    set({ keymap: loadKeymap() });
  },
  reset: () => {
    resetKeymap();
    set({ keymap: loadKeymap() });
  },
}));
