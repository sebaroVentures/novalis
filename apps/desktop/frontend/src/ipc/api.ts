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
  createNote: (path: string, opts?: { content?: string; template?: string }) =>
    unwrap(
      commands.createNote({
        path,
        content: opts?.content ?? null,
        template: opts?.template ?? null,
      }),
    ),
  updateNote: (path: string, content: string) => unwrap(commands.updateNote(path, content)),
  deleteNote: (path: string) => unwrap(commands.deleteNote(path)),
  moveNote: (path: string, newPath: string) => unwrap(commands.moveNote(path, newPath)),
  createFolder: (path: string) => unwrap(commands.createFolder(path)),
  search: (query: string) => unwrap(commands.search(query, null, null)),
  quickSearch: (query: string) => unwrap(commands.quickSearch(query)),
  reindexVault: () => unwrap(commands.reindexVault()),
  getVaultInfo: () => unwrap(commands.getVaultInfo()),
  getPreferences: () => unwrap(commands.getPreferences()),

  // Tasks
  listTasks: (status: "open" | "completed" | "all" = "open") =>
    unwrap(
      commands.listTasks({
        status: status === "all" ? null : status,
        priority: null,
        dueBefore: null,
        dueAfter: null,
        note: null,
        folder: null,
      }),
    ),
  createTask: (
    text: string,
    opts?: { status?: string; priority?: string; dueDate?: string; notePath?: string },
  ) =>
    unwrap(
      commands.createTask({
        text,
        status: opts?.status ?? null,
        priority: opts?.priority ?? null,
        dueDate: opts?.dueDate ?? null,
        notePath: opts?.notePath ?? null,
      }),
    ),
  toggleTask: (id: string) => unwrap(commands.toggleTask(id)),
  setTaskStatus: (id: string, status: string) => unwrap(commands.setTaskStatus(id, status)),

  // Templates / export / media
  listTemplates: () => unwrap(commands.listTemplates()),
  createTemplate: (name: string, content: string, description?: string) =>
    unwrap(commands.createTemplate(name, description ?? null, content)),
  deleteTemplate: (id: string) => unwrap(commands.deleteTemplate(id)),
  setPreferences: (prefs: Parameters<typeof commands.setPreferences>[0]) =>
    unwrap(commands.setPreferences(prefs)),
  exportNote: (path: string, format: "html" | "docx") =>
    unwrap(commands.exportNote(path, format)),
  savePastedImage: (bytes: number[], ext: string) =>
    unwrap(commands.savePastedImage(bytes, ext)),

  // Calendar
  listEvents: (start: string, end: string) => unwrap(commands.listEvents(start, end)),
  getAgenda: (start: string, end: string) => unwrap(commands.getAgenda(start, end)),
  createEvent: (input: EventDraft) => unwrap(commands.createEvent(toEventInput(input))),
  updateEvent: (input: EventDraft) => unwrap(commands.updateEvent(toEventInput(input))),
  deleteEvent: (notePath: string) => unwrap(commands.deleteEvent(notePath)),
  listCalendarSources: () => unwrap(commands.listCalendarSources()),
  addCalendarSource: (cfg: { id: string; kind: string; name: string; url?: string; enabled: boolean }) =>
    unwrap(commands.addCalendarSource({ ...cfg, url: cfg.url ?? null })),
  removeCalendarSource: (id: string) => unwrap(commands.removeCalendarSource(id)),
  refreshCalendarSource: (id: string) => unwrap(commands.refreshCalendarSource(id)),
  importIcs: () => unwrap(commands.importIcs()),
  exportIcs: (start: string, end: string) => unwrap(commands.exportIcs(start, end)),
  oauthBegin: (provider: "google" | "outlook") => unwrap(commands.oauthBegin(provider)),
  oauthStatus: (provider: string) => commands.oauthStatus(provider),
  oauthDisconnect: (provider: string) => unwrap(commands.oauthDisconnect(provider)),
};

export interface EventDraft {
  title: string;
  date: string;
  allDay: boolean;
  startTime?: string;
  endTime?: string;
  rrule?: string;
  location?: string;
  notePath?: string;
}

function toEventInput(d: EventDraft) {
  return {
    title: d.title,
    date: d.date,
    allDay: d.allDay,
    startTime: d.startTime ?? null,
    endTime: d.endTime ?? null,
    rrule: d.rrule ?? null,
    location: d.location ?? null,
    notePath: d.notePath ?? null,
  };
}
