import { create } from "zustand";

// Store-driven PDF viewer (feature W4.2): opening a PDF sets `path`, which mounts
// the full-screen viewer overlay (App.tsx). The picker is a sibling modal opened
// from the command palette. Kept separate from the note-tab workspace — a PDF is
// not a `.md` note.

interface PdfState {
  /** Vault-relative path of the PDF open in the viewer, or null when closed. */
  path: string | null;
  /** Highlight id to scroll to when the viewer opens (from a `#hl=` link). */
  focusHighlightId: string | null;
  /** Whether the "Open PDF" picker modal is open. */
  pickerOpen: boolean;
  open: (path: string, focusHighlightId?: string | null) => void;
  close: () => void;
  openPicker: () => void;
  closePicker: () => void;
}

export const usePdf = create<PdfState>((set) => ({
  path: null,
  focusHighlightId: null,
  pickerOpen: false,
  open: (path, focusHighlightId = null) =>
    set({ path, focusHighlightId, pickerOpen: false }),
  close: () => set({ path: null, focusHighlightId: null }),
  openPicker: () => set({ pickerOpen: true }),
  closePicker: () => set({ pickerOpen: false }),
}));
