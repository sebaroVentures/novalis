import { create } from "zustand";

import { api, events, NovalisError, type RagCitation } from "../ipc/api";
import i18n from "../lib/i18n";

export type ChatStatus = "idle" | "retrieving" | "streaming" | "done" | "error";

/** "Chat with your vault": one single-turn question → grounded, cited answer.
 *  Retrieval + streaming reuse the backend `ai_rag_answer` command and the
 *  shared `ai-stream-*` events (keyed by requestId). Multi-turn history is not
 *  kept — each `ask` replaces the previous answer. */
interface VaultChatState {
  /** Whether the right-docked chat panel is shown. */
  open: boolean;
  status: ChatStatus;
  /** The submitted question, kept for display above the answer. */
  question: string;
  answer: string;
  citations: RagCitation[];
  error: string | null;
  /** Backend streaming id; "" until it resolves (or when retrieval was empty). */
  requestId: string;

  openPanel: () => void;
  closePanel: () => void;
  ask: (connectionId: string, question: string) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

// Monotonic token so a slow invoke / late stream event from a superseded ask
// can't write into a newer one. Bumped on every ask and on cancel.
let seq = 0;
// Detach handle for the in-flight ask's stream listeners, so cancel/close (which
// live outside `ask`'s closure) can tear them down.
let activeCleanup: (() => void) | null = null;

export const useVaultChat = create<VaultChatState>((set, get) => ({
  open: false,
  status: "idle",
  question: "",
  answer: "",
  citations: [],
  error: null,
  requestId: "",

  openPanel: () => set({ open: true }),
  closePanel: () => {
    get().cancel();
    set({ open: false });
  },

  reset: () => {
    get().cancel();
    set({ status: "idle", question: "", answer: "", citations: [], error: null, requestId: "" });
  },

  ask: async (connectionId, question) => {
    const q = question.trim();
    if (!q) return;
    get().cancel(); // stop any prior run + detach its listeners
    const mySeq = ++seq;
    set({
      open: true,
      status: "retrieving",
      question: q,
      answer: "",
      citations: [],
      error: null,
      requestId: "",
    });

    // Stream events can beat the invoke result (the backend spawns the stream
    // before returning the id), so buffer by requestId until we learn ours.
    const buffers = new Map<string, string>();
    const terminal = new Map<string, { ok: boolean; msg: string }>();
    let targetId: string | null = null;
    let cleaned = false;
    const offs: Promise<() => void>[] = [];
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (activeCleanup === cleanup) activeCleanup = null;
      for (const p of offs) void p.then((off) => off());
    };
    activeCleanup = cleanup;
    const superseded = () => seq !== mySeq;

    const applyChunk = (delta: string) => {
      if (superseded()) return;
      set((s) => ({ answer: s.answer + delta, status: "streaming" }));
    };
    const finish = () => {
      if (superseded()) return;
      set({ status: "done" });
      cleanup();
    };
    const fail = (msg: string) => {
      if (superseded()) return;
      set({ status: "error", error: msg });
      cleanup();
    };

    offs.push(
      events.aiStreamChunk.listen((e) => {
        const { requestId, delta } = e.payload;
        if (targetId && requestId === targetId) applyChunk(delta);
        else buffers.set(requestId, (buffers.get(requestId) ?? "") + delta);
      }),
    );
    offs.push(
      events.aiStreamDone.listen((e) => {
        const { requestId } = e.payload;
        if (targetId && requestId === targetId) finish();
        else terminal.set(requestId, { ok: true, msg: "" });
      }),
    );
    offs.push(
      events.aiStreamError.listen((e) => {
        const { requestId, message } = e.payload;
        if (targetId && requestId === targetId) fail(message);
        else terminal.set(requestId, { ok: false, msg: message });
      }),
    );

    try {
      // Attach the listeners before the invoke can make the backend emit, so no
      // early chunk is dropped (events arriving before targetId is known are
      // buffered by requestId above and replayed once it resolves).
      await Promise.all(offs);
      if (superseded()) {
        cleanup();
        return;
      }
      const res = await api.aiRagAnswer(connectionId, q);
      if (superseded()) {
        cleanup();
        return;
      }
      // Empty retrieval: the backend never called the model — show the honest
      // "not in your notes" message rather than a hallucinated answer.
      if (!res.requestId) {
        set({ status: "done", answer: i18n.t("ai:chat.noResults"), citations: [] });
        cleanup();
        return;
      }
      targetId = res.requestId;
      set({ requestId: res.requestId, citations: res.citations, status: "streaming" });
      // Replay anything that streamed in before we knew our id.
      const buffered = buffers.get(res.requestId);
      if (buffered) applyChunk(buffered);
      const term = terminal.get(res.requestId);
      if (term) {
        if (term.ok) finish();
        else fail(term.msg);
      }
    } catch (e) {
      if (superseded()) {
        cleanup();
        return;
      }
      const msg =
        e instanceof NovalisError ? e.message : e instanceof Error ? e.message : String(e);
      set({ status: "error", error: msg });
      cleanup();
    }
  },

  cancel: () => {
    const { requestId, status } = get();
    if (requestId && status === "streaming") void api.aiCancel(requestId);
    // Invalidate the in-flight run and detach its listeners so late events/promise
    // resolutions are ignored. Keep any partial answer, just mark it finished.
    seq++;
    activeCleanup?.();
    set((s) =>
      s.status === "streaming" || s.status === "retrieving" ? { status: "done" } : {},
    );
  },
}));
