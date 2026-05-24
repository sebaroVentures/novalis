// Ergonomic wrapper over the generated Tauri bindings: unwraps the
// `Result<T, CommandError>` union into a value or a thrown `NovalisError`.

import { commands, events } from "./bindings";
import type { CommandError } from "./bindings";

export * from "./bindings";
export { events };

export class NovalisError extends Error {
  kind: string;
  constructor(err: CommandError) {
    super(err.message);
    this.name = "NovalisError";
    this.kind = err.kind;
  }
}

type Res<T> = { status: "ok"; data: T } | { status: "error"; error: CommandError };

async function unwrap<T>(p: Promise<Res<T>>): Promise<T> {
  const r = await p;
  if (r.status === "error") throw new NovalisError(r.error);
  return r.data;
}

export const api = {
  appInfo: () => commands.appInfo(),
  currentVault: () => unwrap(commands.currentVault()),
  pickVaultFolder: () => commands.pickVaultFolder(),
  openVault: (path: string) => unwrap(commands.openVault(path)),
  closeVault: () => unwrap(commands.closeVault()),
  getFolderTree: () => unwrap(commands.getFolderTree()),
  getNote: (path: string) => unwrap(commands.getNote(path)),
  createNote: (path: string, content?: string) =>
    unwrap(commands.createNote({ path, content: content ?? null, template: null })),
  updateNote: (path: string, content: string) => unwrap(commands.updateNote(path, content)),
  deleteNote: (path: string) => unwrap(commands.deleteNote(path)),
  moveNote: (path: string, newPath: string) => unwrap(commands.moveNote(path, newPath)),
  createFolder: (path: string) => unwrap(commands.createFolder(path)),
  search: (query: string) => unwrap(commands.search(query, null, null)),
  quickSearch: (query: string) => unwrap(commands.quickSearch(query)),
  reindexVault: () => unwrap(commands.reindexVault()),
  getVaultInfo: () => unwrap(commands.getVaultInfo()),
};
