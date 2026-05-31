import { create } from "zustand";

import i18n from "../lib/i18n";
import { api, type PluginManifest } from "../ipc/api";

export interface PluginCommand {
  id: string;
  title: string;
  pluginId: string;
  run: () => void;
}

// Host method -> required capability (null = always allowed).
const CAP: Record<string, string | null> = {
  "notes.list": "notes:read",
  "notes.get": "notes:read",
  "notes.create": "notes:write",
  "tasks.list": "tasks:read",
  "tasks.create": "tasks:write",
  search: "search",
};

// Runtime injected into each plugin's Web Worker. The plugin script runs after
// it and talks to the app only through the `novalis` global (postMessage RPC).
const BOOTSTRAP = `
const __pending = new Map();
let __seq = 0;
function __call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++__seq;
    __pending.set(id, { resolve, reject });
    self.postMessage({ type: "rpc", id, method, params: params || {} });
  });
}
const __commands = new Map();
self.novalis = {
  registerCommand(id, title, callback) {
    __commands.set(id, callback);
    self.postMessage({ type: "registerCommand", id, title });
  },
  notes: {
    list: () => __call("notes.list"),
    get: (path) => __call("notes.get", { path }),
    create: (path, content) => __call("notes.create", { path, content }),
  },
  tasks: {
    list: () => __call("tasks.list"),
    create: (text) => __call("tasks.create", { text }),
  },
  search: (query) => __call("search", { query }),
  notify: (message) => self.postMessage({ type: "notify", message: String(message) }),
};
self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "rpcResult") {
    const p = __pending.get(m.id);
    if (p) { __pending.delete(m.id); m.error ? p.reject(new Error(m.error)) : p.resolve(m.result); }
  } else if (m.type === "runCommand") {
    const cb = __commands.get(m.id);
    if (cb) Promise.resolve().then(cb).catch((e) => self.postMessage({ type: "error", message: String(e) }));
  }
};
`;

interface PluginState {
  commands: PluginCommand[];
  notify: (msg: string) => void;
  setNotify: (fn: (msg: string) => void) => void;
  reload: () => Promise<void>;
}

const workers = new Map<string, Worker>();

export const usePlugins = create<PluginState>((set, get) => ({
  commands: [],
  notify: () => {},
  setNotify: (fn) => set({ notify: fn }),

  reload: async () => {
    workers.forEach((w) => w.terminate());
    workers.clear();
    set({ commands: [] });

    let plugins;
    try {
      plugins = await api.listPlugins();
    } catch {
      return;
    }

    for (const p of plugins.filter((x) => x.enabled)) {
      try {
        const src = await api.readPluginSource(p.manifest.id);
        const blob = new Blob([BOOTSTRAP + "\n" + src], { type: "text/javascript" });
        const worker = new Worker(URL.createObjectURL(blob));
        worker.onmessage = (ev) => handleMessage(p.manifest, worker, ev.data, set, get);
        worker.onerror = (e) => get().notify(`[${p.manifest.id}] ${e.message}`);
        workers.set(p.manifest.id, worker);
      } catch (e) {
        get().notify(i18n.t("settings:plugins.loadFailed", { id: p.manifest.id, error: String(e) }));
      }
    }
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = any;

function handleMessage(
  manifest: PluginManifest,
  worker: Worker,
  msg: Msg,
  set: (fn: (s: PluginState) => Partial<PluginState>) => void,
  get: () => PluginState,
) {
  if (msg.type === "registerCommand") {
    const cmd: PluginCommand = {
      id: `${manifest.id}:${msg.id}`,
      title: msg.title,
      pluginId: manifest.id,
      run: () => worker.postMessage({ type: "runCommand", id: msg.id }),
    };
    set((s) => ({ commands: [...s.commands.filter((c) => c.id !== cmd.id), cmd] }));
  } else if (msg.type === "rpc") {
    void dispatchRpc(manifest, msg.method, msg.params).then(
      (result) => worker.postMessage({ type: "rpcResult", id: msg.id, result }),
      (err) => worker.postMessage({ type: "rpcResult", id: msg.id, error: String(err) }),
    );
  } else if (msg.type === "notify") {
    get().notify(`${manifest.name}: ${msg.message}`);
  } else if (msg.type === "error") {
    get().notify(`[${manifest.id}] ${msg.message}`);
  }
}

async function dispatchRpc(manifest: PluginManifest, method: string, params: Msg): Promise<unknown> {
  const need = CAP[method];
  if (need && !(manifest.capabilities ?? []).includes(need)) {
    throw new Error(`Capability '${need}' not granted to ${manifest.id}`);
  }
  switch (method) {
    case "notes.list":
      return api.listNotes();
    case "notes.get":
      return api.getNote(params.path);
    case "notes.create":
      return api.createNote(params.path, { content: params.content });
    case "tasks.list":
      return api.listTasks("all");
    case "tasks.create":
      return api.createTask(params.text);
    case "search":
      return api.search(params.query);
    default:
      throw new Error(`Unknown host method: ${method}`);
  }
}
