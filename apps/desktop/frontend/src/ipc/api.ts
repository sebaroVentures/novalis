// Ergonomic wrapper over the generated Tauri bindings: unwraps the
// `Result<T, CommandError>` union into a value or a thrown `NovalisError`.

import { commands, events } from "./bindings";
import type { CommandError, PropertyValue } from "./bindings";

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
  validateVault: (path: string) => unwrap(commands.validateVault(path)),
  listRecentVaults: () => unwrap(commands.listRecentVaults()),
  removeRecentVault: (path: string) => unwrap(commands.removeRecentVault(path)),
  getFolderTree: () => unwrap(commands.getFolderTree()),
  listNotes: () => unwrap(commands.listNotes()),
  getNote: (path: string) => unwrap(commands.getNote(path)),
  resolveEmbed: (target: string) => unwrap(commands.resolveEmbed(target)),
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
  resolveOrCreateWikiLink: (title: string) => unwrap(commands.resolveOrCreateWikiLink(title)),
  moveNote: (path: string, newPath: string) => unwrap(commands.moveNote(path, newPath)),
  duplicateNote: (path: string) => unwrap(commands.duplicateNote(path)),
  updateNoteMeta: (req: Parameters<typeof commands.updateNoteMeta>[0]) =>
    unwrap(commands.updateNoteMeta(req)),
  setProperty: (path: string, key: string, value: PropertyValue) =>
    unwrap(commands.setProperty(path, key, value)),
  removeProperty: (path: string, key: string) => unwrap(commands.removeProperty(path, key)),
  renameProperty: (path: string, from: string, to: string) =>
    unwrap(commands.renameProperty(path, from, to)),
  createFolder: (path: string) => unwrap(commands.createFolder(path)),
  deleteFolder: (path: string) => unwrap(commands.deleteFolder(path)),
  deleteFolderRecursive: (path: string) => unwrap(commands.deleteFolderRecursive(path)),
  moveFolder: (path: string, newPath: string) => unwrap(commands.moveFolder(path, newPath)),
  search: (query: string, folder?: string | null, tag?: string | null) =>
    unwrap(commands.search(query, folder ?? null, tag ?? null)),
  quickSearch: (query: string) => unwrap(commands.quickSearch(query)),
  listTags: () => unwrap(commands.listTags()),
  diffVersion: (path: string, versionId: string) =>
    unwrap(commands.diffVersion(path, versionId)),

  // Linked writing
  backlinks: (title: string) => unwrap(commands.backlinks(title)),
  unlinkedMentions: (title: string, selfPath: string) =>
    unwrap(commands.unlinkedMentions(title, selfPath)),
  linkMention: (path: string, title: string, line: number) =>
    unwrap(commands.linkMention(path, title, line)),
  noteGraph: (path: string) => unwrap(commands.noteGraph(path)),
  reindexVault: () => unwrap(commands.reindexVault()),
  rescanVault: () => unwrap(commands.rescanVault()),
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
  updateTask: (
    id: string,
    field: "project" | "epic" | "priority" | "due" | "start" | "remind",
    value: string | null,
  ) =>
    unwrap(commands.updateTask(id, field, value)),
  deleteTask: (id: string) => unwrap(commands.deleteTask(id)),

  // Templates / export / media
  listTemplates: () => unwrap(commands.listTemplates()),
  createTemplate: (name: string, content: string, description?: string) =>
    unwrap(commands.createTemplate(name, description ?? null, content)),
  deleteTemplate: (id: string) => unwrap(commands.deleteTemplate(id)),
  renderTemplate: (content: string, title: string | null) =>
    commands.renderTemplate(content, title),
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

  // Plugins
  listPlugins: () => unwrap(commands.listPlugins()),
  setPluginEnabled: (id: string, enabled: boolean) =>
    unwrap(commands.setPluginEnabled(id, enabled)),
  readPluginSource: (id: string) => unwrap(commands.readPluginSource(id)),

  // Trash (Recently deleted)
  listTrash: () => unwrap(commands.listTrash()),
  restoreTrash: (id: string) => unwrap(commands.restoreTrash(id)),
  deleteTrashItem: (id: string) => unwrap(commands.deleteTrashItem(id)),
  emptyTrash: () => unwrap(commands.emptyTrash()),

  // Version history
  listVersions: (path: string) => unwrap(commands.listVersions(path)),
  readVersion: (path: string, versionId: string) =>
    unwrap(commands.readVersion(path, versionId)),
  restoreVersion: (path: string, versionId: string) =>
    unwrap(commands.restoreVersion(path, versionId)),

  // Sync conflicts
  listConflicts: () => unwrap(commands.listConflicts()),
  conflictDiff: (original: string, conflict: string) =>
    unwrap(commands.conflictDiff(original, conflict)),
  resolveConflict: (req: Parameters<typeof commands.resolveConflict>[0]) =>
    unwrap(commands.resolveConflict(req)),
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
