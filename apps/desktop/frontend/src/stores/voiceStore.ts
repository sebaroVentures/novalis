import { create } from "zustand";

import { getMarkdown, type Editor } from "@novalis/editor";

import { api } from "../ipc/api";
import { displayError } from "../lib/errors";
import i18n from "../lib/i18n";
import { useAi } from "./aiStore";
import { useUi } from "./uiStore";
import { useVault } from "./vaultStore";

// Native voice/meeting capture (feature W4.3). Orchestrates the whole pipeline
// on top of existing commands: record (cpal) → stop → transcribe on-device
// (whisper) → write a transcript note → open it → hand it to the existing hidden
// `extract-tasks` review (accept/reject). Desktop-only; `available` is false on
// mobile, where the backend commands return a clear "unavailable" error.

export type VoiceStatus = "idle" | "recording" | "transcribing" | "error";

/** Where transcript notes land, and how long to wait for the freshly-opened
 *  note's editor to mount before handing it to the task-extract review. */
const VOICE_FOLDER = "Voice Notes";
const EDITOR_WAIT_MS = 6000;

interface VoiceState {
  /** Whether native capture works here (probed once from the backend). */
  available: boolean;
  status: VoiceStatus;
  /** User-facing error for the last failed step, or null. */
  error: string | null;
  /** Path of the note the last successful run produced (for a gentle notice). */
  lastNotePath: string | null;

  checkAvailability: () => Promise<void>;
  start: () => Promise<void>;
  /** Stop recording, transcribe, create + open the note, open the task review. */
  stopAndProcess: () => Promise<void>;
  cancel: () => Promise<void>;
  clearError: () => void;
}

/** Two-digit zero-pad. */
const pad = (n: number) => String(n).padStart(2, "0");

/** A collision-resistant, human-readable transcript filename stem. */
function transcriptName(d: Date): string {
  return `Meeting ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Resolve once the freshly-opened note's editor is mounted and focused, so the
 *  task-extract review (which wants a live editor) has one. Rejects on timeout —
 *  the caller then falls back to a "note saved, run Extract Tasks" notice. */
function waitForActiveEditor(path: string, timeoutMs: number): Promise<Editor> {
  return new Promise<Editor>((resolve, reject) => {
    const check = () => getEditorFor(path);
    const immediate = check();
    if (immediate) {
      resolve(immediate);
      return;
    }
    const started = Date.now();
    const unsub = useUi.subscribe(() => {
      const ed = check();
      if (ed) {
        unsub();
        clearInterval(timer);
        resolve(ed);
      }
    });
    // Belt-and-suspenders poll: the editor sets activeEditor on mount, but the
    // store subscription alone can miss the exact tick, so poll too.
    const timer = setInterval(() => {
      const ed = check();
      if (ed) {
        unsub();
        clearInterval(timer);
        resolve(ed);
      } else if (Date.now() - started > timeoutMs) {
        unsub();
        clearInterval(timer);
        reject(new Error("editor did not mount"));
      }
    }, 80);
  });
}

/** The live active editor iff it belongs to `path`, else null. */
function getEditorFor(path: string): Editor | null {
  const ed = useUi.getState().activeEditor;
  const active = useVault.getState().activeNote;
  if (ed && !ed.isDestroyed && active?.path === path) return ed;
  return null;
}

export const useVoice = create<VoiceState>((set, get) => ({
  available: false,
  status: "idle",
  error: null,
  lastNotePath: null,

  checkAvailability: async () => {
    try {
      const caps = await api.voiceCapabilities();
      set({ available: caps.available });
    } catch {
      set({ available: false });
    }
  },

  start: async () => {
    if (get().status === "recording" || get().status === "transcribing") return;
    set({ error: null, status: "recording", lastNotePath: null });
    try {
      await api.voiceStartRecording();
    } catch (e) {
      set({ status: "error", error: displayError(e) });
    }
  },

  cancel: async () => {
    if (get().status !== "recording") return;
    try {
      // Stop discards the take: we don't transcribe or create a note.
      await api.voiceStopRecording();
    } catch {
      // Ignore — cancelling is best-effort.
    }
    set({ status: "idle", error: null });
  },

  stopAndProcess: async () => {
    if (get().status !== "recording") return;
    set({ status: "transcribing", error: null });
    try {
      const rec = await api.voiceStopRecording();
      const transcript = (await api.voiceTranscribe(rec.path)).trim();
      if (!transcript) {
        set({ status: "error", error: i18n.t("ai:voice.noSpeech") });
        return;
      }

      // Write the transcript as a note (create_note adds frontmatter + a title
      // heading from the filename stem when the content has no frontmatter).
      const stem = transcriptName(new Date());
      const notePath = await createTranscriptNote(stem, transcript);

      // Open it in the workspace, then hand its live editor to the existing
      // task-extraction review so the model's proposed tasks get the usual
      // accept/reject flow.
      await useVault.getState().refreshTree();
      useUi.getState().openInWorkspace(notePath);

      try {
        const ed = await waitForActiveEditor(notePath, EDITOR_WAIT_MS);
        useAi.getState().startTaskExtract({
          editor: ed,
          notePath,
          noteTitle: stem,
          body: getMarkdown(ed),
        });
      } catch {
        // Editor never mounted (rare): the transcript is safely saved; the user
        // can open it and run Extract Tasks manually.
      }
      set({ status: "idle", lastNotePath: notePath });
    } catch (e) {
      set({ status: "error", error: displayError(e) });
    }
  },

  clearError: () => set({ error: null, status: "idle" }),
}));

/** Create the transcript note, retrying the filename on a rare collision. */
async function createTranscriptNote(stem: string, transcript: string): Promise<string> {
  const body = `${transcript}\n`;
  for (let i = 0; i < 25; i++) {
    const name = i === 0 ? stem : `${stem} (${i + 1})`;
    const path = `${VOICE_FOLDER}/${name}.md`;
    try {
      const note = await api.createNote(path, { content: body });
      return note.path;
    } catch (e) {
      if (e instanceof Error && /already exists/i.test(e.message)) continue;
      throw e;
    }
  }
  throw new Error("could not create the transcript note");
}
