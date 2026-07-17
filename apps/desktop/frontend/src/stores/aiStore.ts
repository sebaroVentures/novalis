import { create } from "zustand";

import { getMarkdown, type Editor } from "@novalis/editor";

import { displayError } from "../lib/errors";
import i18n from "../lib/i18n";
import {
  api,
  events,
  type AiActionView,
  type AiConnectionConfig,
  type AiConnectionView,
  type AiContext,
  type AiTemplate,
  type AiTemplateScope,
} from "../ipc/api";
import { useVault } from "./vaultStore";

// The chosen connection is device-local UI state, remembered across sessions.
const SELECTED_KEY = "nv:ai:selectedConnection";

export type AiRunStatus = "streaming" | "done" | "error";

/** The note the meeting-note → task-extraction review is open for. Set by the
 *  editor AI menu / command palette; the store-mounted review card reads it and
 *  runs the hidden `extract-tasks` action against `body`. */
export interface TaskExtractTarget {
  editor: Editor;
  notePath: string;
  noteTitle: string;
  /** Note body (markdown, without frontmatter) captured when the review opened. */
  body: string;
}

/** The note the AI weekly-review card is open for. The card fetches the
 *  deterministic digest itself, runs the hidden `weekly-review` action against
 *  it, and appends accepted carry-overs under an "## Actions" heading in this
 *  note (the same insertion path as the task-extraction review). */
export interface WeeklyReviewTarget {
  editor: Editor;
  notePath: string;
  noteTitle: string;
  /** Note body (markdown, without frontmatter) captured when the review opened. */
  body: string;
}

/** The single in-flight (or just-finished) AI action, streamed into the panel. */
export interface AiRun {
  /** Backend request id; empty until `aiRunAction` resolves. */
  id: string;
  connectionId: string;
  actionId: string;
  /** Already-translated action title for the panel header. */
  title: string;
  status: AiRunStatus;
  text: string;
  error: string | null;
}

interface AiState {
  connections: AiConnectionView[];
  actions: AiActionView[];
  templates: AiTemplate[];
  loaded: boolean;
  /** Set when `load()` failed — otherwise an unreachable backend renders as
   *  "no connections configured", which is a lie. */
  loadError: string | null;
  selectedConnectionId: string | null;
  run: AiRun | null;
  /** Open task-extraction review target, or null when closed. */
  taskExtract: TaskExtractTarget | null;
  /** Open AI weekly-review target, or null when closed. */
  weeklyReview: WeeklyReviewTarget | null;

  load: () => Promise<void>;
  setSelectedConnection: (id: string | null) => void;

  upsertConnection: (config: AiConnectionConfig) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;

  saveTemplate: (name: string, body: string, scope: AiTemplateScope) => Promise<void>;
  deleteTemplate: (id: string, scope: AiTemplateScope) => Promise<void>;

  startRun: (args: {
    connectionId: string;
    actionId: string;
    title: string;
    notePath: string | null;
    context: AiContext;
    userInput?: string | null;
  }) => Promise<void>;
  cancelRun: () => void;
  clearRun: () => void;

  /** Open / close the meeting-note → task-extraction review for a note. */
  startTaskExtract: (target: TaskExtractTarget) => void;
  closeTaskExtract: () => void;

  /** Open / close the AI weekly-review card for a note. */
  startWeeklyReview: (target: WeeklyReviewTarget) => void;
  closeWeeklyReview: () => void;

  /** Run an action to completion and resolve with its full text, WITHOUT
   *  routing it into the floating panel (`run`). Used by features that consume
   *  the whole result programmatically (rewrite review, metadata suggestions). */
  collectAiAction: (args: {
    connectionId: string;
    actionId: string;
    notePath: string | null;
    context: AiContext;
    userInput?: string | null;
  }) => Promise<string>;

  /** True while a rewrite proposal is being generated (before the inline
   *  track-changes review opens). Drives the review bar's pending state. */
  rewriting: boolean;
  /** Generate a rewrite of the captured selection and open the inline
   *  track-changes review on it (via the editor's SuggestRewrite commands). */
  runRewrite: (args: {
    editor: Editor;
    connectionId: string;
    notePath: string | null;
    noteTitle: string;
    from: number;
    to: number;
    selection: string;
    userInput?: string | null;
  }) => Promise<void>;

  // Called by useAiEvents; matched against the active run by request id.
  appendChunk: (requestId: string, delta: string) => void;
  finishRun: (requestId: string) => void;
  failRun: (requestId: string, message: string) => void;
}

/** First connection that is enabled, has a key, and is reachable/installed. */
function firstUsable(connections: AiConnectionView[]): AiConnectionView | undefined {
  return connections.find((c) => c.enabled && c.configured && c.available);
}

/** Stream events for one request id that arrived before the panel run learned
 *  its id (the invoke result can lose the race against the first events). */
interface PendingRunEvents {
  text: string;
  terminal: { ok: boolean; msg: string } | null;
}

// `ai-stream-*` events can beat the `aiRunAction` invoke result — e.g. a
// missing CLI binary fails immediately, before the panel run knows its id —
// and appendChunk/finishRun/failRun match on that id. Mirror collectAiAction's
// fix: while the panel run awaits its id, buffer events per request id, then
// replay the resolved id's buffer and discard the rest.
const pending = new Map<string, PendingRunEvents>();

function bufferFor(requestId: string): PendingRunEvents {
  let p = pending.get(requestId);
  if (!p) {
    p = { text: "", terminal: null };
    pending.set(requestId, p);
  }
  return p;
}

/** True while the panel run exists but its backend id is not yet known. */
function awaitingRunId(run: AiRun | null): boolean {
  return run != null && run.id === "" && run.status === "streaming";
}

// Monotonic token so a slow `aiRunAction` invoke can't attach its id (or
// replay its buffer) onto a newer run that replaced it meanwhile.
let runSeq = 0;

export const useAi = create<AiState>((set, get) => ({
  connections: [],
  actions: [],
  templates: [],
  loaded: false,
  loadError: null,
  selectedConnectionId: localStorage.getItem(SELECTED_KEY),
  run: null,
  taskExtract: null,
  weeklyReview: null,

  load: async () => {
    try {
      const [connections, actions, templates] = await Promise.all([
        api.aiListConnections(),
        api.aiListActions(),
        api.aiListTemplates(),
      ]);
      // Keep the saved choice if it's still usable; otherwise fall back.
      const saved = get().selectedConnectionId;
      const stillUsable =
        saved != null &&
        connections.some((c) => c.id === saved && c.enabled && c.configured && c.available);
      const selectedConnectionId = stillUsable ? saved : (firstUsable(connections)?.id ?? null);
      set({ connections, actions, templates, loaded: true, loadError: null, selectedConnectionId });
    } catch (e) {
      set({ loaded: true, loadError: displayError(e) });
    }
  },

  saveTemplate: async (name, body, scope) => {
    const templates = await api.aiSaveTemplate(name, body, scope);
    set({ templates });
  },

  deleteTemplate: async (id, scope) => {
    try {
      const templates = await api.aiDeleteTemplate(id, scope);
      set({ templates });
    } catch (e) {
      useVault.getState().reportError(e);
    }
  },

  setSelectedConnection: (id) => {
    if (id) localStorage.setItem(SELECTED_KEY, id);
    else localStorage.removeItem(SELECTED_KEY);
    set({ selectedConnectionId: id });
  },

  upsertConnection: async (config) => {
    const connections = await api.aiUpsertConnection(config);
    set({ connections });
  },

  deleteConnection: async (id) => {
    const connections = await api.aiDeleteConnection(id);
    set((s) => ({
      connections,
      selectedConnectionId: s.selectedConnectionId === id ? (firstUsable(connections)?.id ?? null) : s.selectedConnectionId,
    }));
  },

  startRun: async (args) => {
    // Replace any previous run (cancel it first so its stream stops emitting).
    get().cancelRun();
    const seq = ++runSeq;
    pending.clear();
    set({
      run: {
        id: "",
        connectionId: args.connectionId,
        actionId: args.actionId,
        title: args.title,
        status: "streaming",
        text: "",
        error: null,
      },
    });
    try {
      const requestId = await api.aiRunAction({
        connectionId: args.connectionId,
        actionId: args.actionId,
        notePath: args.notePath,
        context: args.context,
        userInput: args.userInput ?? null,
      });
      if (seq !== runSeq) return; // superseded by a newer run
      set((s) => (s.run ? { run: { ...s.run, id: requestId } } : {}));
      // Replay anything that streamed in before the id was known.
      const buffered = pending.get(requestId);
      pending.clear();
      if (buffered?.text) get().appendChunk(requestId, buffered.text);
      if (buffered?.terminal) {
        if (buffered.terminal.ok) get().finishRun(requestId);
        else get().failRun(requestId, buffered.terminal.msg);
      }
    } catch (e) {
      if (seq !== runSeq) return;
      pending.clear();
      const message = e instanceof Error ? e.message : String(e);
      set((s) => (s.run ? { run: { ...s.run, status: "error", error: message } } : {}));
    }
  },

  cancelRun: () => {
    const run = get().run;
    if (run && run.id && run.status === "streaming") void api.aiCancel(run.id);
  },

  clearRun: () => {
    get().cancelRun();
    set({ run: null });
  },

  startTaskExtract: (target) => set({ taskExtract: target }),
  closeTaskExtract: () => set({ taskExtract: null }),

  startWeeklyReview: (target) => set({ weeklyReview: target }),
  closeWeeklyReview: () => set({ weeklyReview: null }),

  collectAiAction: (args) =>
    // Buffer every stream event by request id from the moment we subscribe, so
    // chunks that arrive before `aiRunAction` resolves with our id are not
    // lost; once we know the id we settle on its terminal event. Other runs'
    // events land in the maps too but are simply ignored, then discarded.
    new Promise<string>((resolve, reject) => {
      const buffers = new Map<string, string>();
      const terminal = new Map<string, { ok: boolean; msg: string }>();
      let targetId: string | null = null;
      let settled = false;
      const offs: Promise<() => void>[] = [];
      const cleanup = () => {
        for (const p of offs) void p.then((off) => off());
      };
      const trySettle = () => {
        if (settled || targetId == null) return;
        const term = terminal.get(targetId);
        if (!term) return;
        settled = true;
        cleanup();
        if (term.ok) resolve(buffers.get(targetId) ?? "");
        else reject(new Error(term.msg));
      };
      offs.push(
        events.aiStreamChunk.listen((e) => {
          buffers.set(e.payload.requestId, (buffers.get(e.payload.requestId) ?? "") + e.payload.delta);
        }),
      );
      offs.push(
        events.aiStreamDone.listen((e) => {
          terminal.set(e.payload.requestId, { ok: true, msg: "" });
          trySettle();
        }),
      );
      offs.push(
        events.aiStreamError.listen((e) => {
          terminal.set(e.payload.requestId, { ok: false, msg: e.payload.message });
          trySettle();
        }),
      );
      api
        .aiRunAction({
          connectionId: args.connectionId,
          actionId: args.actionId,
          notePath: args.notePath,
          context: args.context,
          userInput: args.userInput ?? null,
        })
        .then((id) => {
          targetId = id;
          trySettle();
        })
        .catch((e) => {
          settled = true;
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
        });
    }),

  rewriting: false,

  runRewrite: async ({ editor, connectionId, notePath, noteTitle, from, to, selection, userInput }) => {
    set({ rewriting: true });
    try {
      const text = await get().collectAiAction({
        connectionId,
        actionId: "rewrite",
        notePath,
        context: { title: noteTitle, markdown: getMarkdown(editor), selection },
        userInput: userInput ?? null,
      });
      const trimmed = text.trim();
      if (trimmed) {
        // The document may have changed while the rewrite streamed. If the
        // captured range no longer holds the original selection, proposing
        // would overlay the wrong text — fail visibly instead.
        const { doc } = editor.state;
        const intact =
          to <= doc.content.size && doc.textBetween(from, to, "\n") === selection;
        if (!intact) throw new Error(i18n.t("ai:rewrite.staleSelection"));
        editor.commands.proposeRewrite(from, to, trimmed);
      }
    } catch (e) {
      // Surface the failure through the floating panel's error state.
      set({
        run: {
          id: "",
          connectionId,
          actionId: "rewrite",
          title: "AI rewrite",
          status: "error",
          text: "",
          error: e instanceof Error ? e.message : String(e),
        },
      });
    } finally {
      set({ rewriting: false });
    }
  },

  appendChunk: (requestId, delta) => {
    if (awaitingRunId(get().run)) {
      bufferFor(requestId).text += delta;
      return;
    }
    set((s) =>
      s.run && s.run.id === requestId && s.run.status === "streaming"
        ? { run: { ...s.run, text: s.run.text + delta } }
        : {},
    );
  },

  finishRun: (requestId) => {
    if (awaitingRunId(get().run)) {
      bufferFor(requestId).terminal = { ok: true, msg: "" };
      return;
    }
    set((s) =>
      s.run && s.run.id === requestId && s.run.status === "streaming"
        ? { run: { ...s.run, status: "done" } }
        : {},
    );
  },

  failRun: (requestId, message) => {
    if (awaitingRunId(get().run)) {
      bufferFor(requestId).terminal = { ok: false, msg: message };
      return;
    }
    set((s) =>
      s.run && s.run.id === requestId
        ? { run: { ...s.run, status: "error", error: message } }
        : {},
    );
  },
}));
