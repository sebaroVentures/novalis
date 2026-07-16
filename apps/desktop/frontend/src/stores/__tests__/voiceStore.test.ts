// voiceStore's recording lifecycle around plaintext WAV hygiene: cancel must be
// a true discard (backend cancel, never stop→persist), and stopAndProcess must
// delete the finalized WAV once the transcript is safely in the vault (or the
// take is abandoned as no-speech) — a failed delete is logged, never fatal. The
// ipc module is mocked, so no Tauri runtime is needed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOTE_PATH = "Voice Notes/Meeting test.md";

const mocks = vi.hoisted(() => ({
  voiceStopRecording: vi.fn(),
  voiceCancelRecording: vi.fn(),
  voiceDeleteRecording: vi.fn(),
  voiceTranscribe: vi.fn(),
  createNote: vi.fn(),
  refreshTree: vi.fn(),
  openInWorkspace: vi.fn(),
  startTaskExtract: vi.fn(),
  editor: { isDestroyed: false },
}));

vi.mock("../../ipc/api", () => ({
  api: {
    voiceStopRecording: mocks.voiceStopRecording,
    voiceCancelRecording: mocks.voiceCancelRecording,
    voiceDeleteRecording: mocks.voiceDeleteRecording,
    voiceTranscribe: mocks.voiceTranscribe,
    createNote: mocks.createNote,
  },
}));
vi.mock("@novalis/editor", () => ({ getMarkdown: () => "transcript" }));
vi.mock("../../lib/errors", () => ({ displayError: (e: unknown) => String(e) }));
vi.mock("../../lib/i18n", () => ({ default: { t: (k: string) => k } }));
vi.mock("../aiStore", () => ({
  useAi: { getState: () => ({ startTaskExtract: mocks.startTaskExtract }) },
}));
// The active editor already belongs to the created note, so stopAndProcess's
// wait-for-editor resolves immediately (its timeout path isn't under test).
vi.mock("../uiStore", () => ({
  useUi: {
    getState: () => ({ activeEditor: mocks.editor, openInWorkspace: mocks.openInWorkspace }),
    subscribe: () => () => {},
  },
}));
vi.mock("../vaultStore", () => ({
  useVault: {
    getState: () => ({
      refreshTree: mocks.refreshTree,
      activeNote: { path: "Voice Notes/Meeting test.md" },
    }),
  },
}));

import { useVoice } from "../voiceStore";

beforeEach(() => {
  for (const fn of Object.values(mocks)) {
    if (typeof fn === "function") fn.mockReset();
  }
  mocks.voiceDeleteRecording.mockResolvedValue(undefined);
  mocks.refreshTree.mockResolvedValue(undefined);
  useVoice.setState({
    available: true,
    status: "recording",
    error: null,
    lastNotePath: null,
    recordingStartedAt: Date.now(),
  });
});

describe("voiceStore.cancel", () => {
  it("discards the take via the backend cancel — never stop (which persists a WAV)", async () => {
    mocks.voiceCancelRecording.mockResolvedValue(undefined);

    await useVoice.getState().cancel();

    expect(mocks.voiceCancelRecording).toHaveBeenCalledTimes(1);
    expect(mocks.voiceStopRecording).not.toHaveBeenCalled();
    expect(mocks.voiceTranscribe).not.toHaveBeenCalled();
    expect(useVoice.getState().status).toBe("idle");
    expect(useVoice.getState().recordingStartedAt).toBeNull();
  });

  it("still resets to idle when the backend cancel fails (best-effort)", async () => {
    mocks.voiceCancelRecording.mockRejectedValue(new Error("nope"));

    await useVoice.getState().cancel();

    expect(useVoice.getState().status).toBe("idle");
    expect(useVoice.getState().error).toBeNull();
  });
});

describe("voiceStore.stopAndProcess", () => {
  it("deletes the WAV (by bare basename) after the transcript note is created", async () => {
    mocks.voiceStopRecording.mockResolvedValue({
      path: "/data/voice/recording-abc.wav",
      durationSecs: 1.5,
    });
    mocks.voiceTranscribe.mockResolvedValue("hello world");
    mocks.createNote.mockResolvedValue({ path: NOTE_PATH });

    await useVoice.getState().stopAndProcess();

    expect(mocks.voiceDeleteRecording).toHaveBeenCalledWith("recording-abc.wav");
    // The WAV is only deleted once the transcript is safely in the vault.
    expect(mocks.voiceDeleteRecording.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.createNote.mock.invocationCallOrder[0],
    );
    expect(useVoice.getState().status).toBe("idle");
    expect(useVoice.getState().lastNotePath).toBe(NOTE_PATH);
  });

  it("treats a failed WAV delete as non-fatal (log only)", async () => {
    mocks.voiceStopRecording.mockResolvedValue({
      path: "/data/voice/recording-abc.wav",
      durationSecs: 1.5,
    });
    mocks.voiceTranscribe.mockResolvedValue("hello world");
    mocks.createNote.mockResolvedValue({ path: NOTE_PATH });
    mocks.voiceDeleteRecording.mockRejectedValue(new Error("locked"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await useVoice.getState().stopAndProcess();

    expect(logged).toHaveBeenCalled();
    expect(useVoice.getState().status).toBe("idle");
    expect(useVoice.getState().lastNotePath).toBe(NOTE_PATH);
    logged.mockRestore();
  });

  it("deletes the abandoned take when the transcript is empty (no-speech)", async () => {
    mocks.voiceStopRecording.mockResolvedValue({
      path: "/data/voice/recording-abc.wav",
      durationSecs: 1.5,
    });
    mocks.voiceTranscribe.mockResolvedValue("   ");

    await useVoice.getState().stopAndProcess();

    expect(mocks.voiceDeleteRecording).toHaveBeenCalledWith("recording-abc.wav");
    expect(mocks.createNote).not.toHaveBeenCalled();
    expect(useVoice.getState().status).toBe("error");
    expect(useVoice.getState().error).toBe("ai:voice.noSpeech");
  });
});
