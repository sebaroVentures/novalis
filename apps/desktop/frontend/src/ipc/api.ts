// Ergonomic wrapper over the generated Tauri bindings: unwraps the
// `Result<T, CommandError>` union into a value or a thrown `NovalisError`.

import { commands, events } from "./bindings";
import type { AiTemplateScope, CommandError, PropertyValue } from "./bindings";

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
  platformInfo: () => commands.platformInfo(),
  defaultVaultPath: () => unwrap(commands.defaultVaultPath()),
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
  revealInFileManager: (path: string) => unwrap(commands.revealInFileManager(path)),
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
  // Canvas (.canvas spatial documents — opaque JSON to the backend)
  listCanvases: () => unwrap(commands.listCanvases()),
  readCanvas: (path: string) => unwrap(commands.readCanvas(path)),
  writeCanvas: (path: string, content: string) => unwrap(commands.writeCanvas(path, content)),
  createCanvas: (path: string, content: string) => unwrap(commands.createCanvas(path, content)),
  deleteCanvas: (path: string) => unwrap(commands.deleteCanvas(path)),

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

  // Block references (`((^id))`)
  searchBlocks: (query: string) => unwrap(commands.searchBlocks(query)),
  resolveBlock: (blockId: string) => unwrap(commands.resolveBlock(blockId)),
  blockBacklinks: (blockId: string) => unwrap(commands.blockBacklinks(blockId)),
  // note_graph (1-hop, index-only) is retained as a cheap fast path even
  // though the local graph UI now slices the full graph client-side — no
  // frontend caller today, deliberate (not silently dead).
  noteGraph: (path: string) => unwrap(commands.noteGraph(path)),
  fullGraph: () => unwrap(commands.fullGraph()),
  reindexVault: () => unwrap(commands.reindexVault()),
  rescanVault: () => unwrap(commands.rescanVault()),
  getVaultInfo: () => unwrap(commands.getVaultInfo()),
  getPreferences: () => unwrap(commands.getPreferences()),
  runQuery: (query: string) => unwrap(commands.runQuery(query)),

  // Git sync (P1 local auto-commit; P2 https remote)
  gitStatus: () => unwrap(commands.gitStatus()),
  gitCommitNow: () => unwrap(commands.gitCommitNow()),
  gitSetRemote: (url: string | null) => unwrap(commands.gitSetRemote(url)),
  // Write-only: the token goes to the OS keychain and never comes back.
  gitSetToken: (token: string) => unwrap(commands.gitSetToken(token)),
  gitHasToken: () => unwrap(commands.gitHasToken()),
  gitSyncNow: () => unwrap(commands.gitSyncNow()),
  // 3-way merge conflict resolution (P3a)
  gitMergeConflicts: () => unwrap(commands.gitMergeConflicts()),
  gitFinalizeMerge: (resolutions: Parameters<typeof commands.gitFinalizeMerge>[0]) =>
    unwrap(commands.gitFinalizeMerge(resolutions)),

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
    field: "project" | "epic" | "priority" | "due" | "start" | "remind" | "repeat",
    value: string | null,
  ) =>
    unwrap(commands.updateTask(id, field, value)),
  deleteTask: (id: string) => unwrap(commands.deleteTask(id)),
  moveTask: (id: string, destNote: string) => unwrap(commands.moveTask(id, destNote)),

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
  reviewDigest: (rangeStart: string, rangeEnd: string) =>
    unwrap(commands.reviewDigest(rangeStart, rangeEnd)),
  createEvent: (input: EventDraft) => unwrap(commands.createEvent(toEventInput(input))),
  updateEvent: (input: EventDraft) => unwrap(commands.updateEvent(toEventInput(input))),
  deleteEvent: (notePath: string) => unwrap(commands.deleteEvent(notePath)),
  addMeetingNote: (notePath: string, date: string) =>
    unwrap(commands.addMeetingNote(notePath, date)),
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

  // AI
  aiListActions: () => commands.aiListActions(),
  aiListConnections: () => unwrap(commands.aiListConnections()),
  aiUpsertConnection: (config: Parameters<typeof commands.aiUpsertConnection>[0]) =>
    unwrap(commands.aiUpsertConnection(config)),
  aiDeleteConnection: (id: string) => unwrap(commands.aiDeleteConnection(id)),
  // Write-only: the API key goes to the OS keychain and never comes back.
  aiSetApiKey: (id: string, key: string) => unwrap(commands.aiSetApiKey(id, key)),
  aiClearApiKey: (id: string) => unwrap(commands.aiClearApiKey(id)),
  aiHasApiKey: (id: string) => unwrap(commands.aiHasApiKey(id)),
  aiTestConnection: (id: string) => unwrap(commands.aiTestConnection(id)),
  aiRunAction: (req: Parameters<typeof commands.aiRunAction>[0]) =>
    unwrap(commands.aiRunAction(req)),
  aiCancel: (requestId: string) => unwrap(commands.aiCancel(requestId)),
  aiListTemplates: () => unwrap(commands.aiListTemplates()),
  aiSaveTemplate: (name: string, body: string, scope: AiTemplateScope) =>
    unwrap(commands.aiSaveTemplate(name, body, scope)),
  aiDeleteTemplate: (id: string, scope: AiTemplateScope) =>
    unwrap(commands.aiDeleteTemplate(id, scope)),
  // Semantic index (on-device vectors; build is the only network/token cost).
  aiEmbeddingConfig: () => unwrap(commands.aiEmbeddingConfig()),
  // Blank connectionId clears the config.
  aiSetEmbeddingConfig: (connectionId: string, model: string) =>
    unwrap(commands.aiSetEmbeddingConfig(connectionId, model)),
  aiEmbedStatus: () => unwrap(commands.aiEmbedStatus()),
  aiBuildEmbeddings: () => unwrap(commands.aiBuildEmbeddings()),
  aiFindRelated: (path: string, limit: number) =>
    unwrap(commands.aiFindRelated(path, limit)),
  // Chat with your vault: retrieves + returns citations, streams the answer over
  // the shared ai-stream-* events keyed by the returned requestId.
  aiRagAnswer: (connectionId: string, question: string) =>
    unwrap(commands.aiRagAnswer(connectionId, question)),
  // Entity graph (W3.3): on-demand LLM extraction, then index-only reads.
  // extractNote runs the model to completion, so it's the only network/token cost.
  entitiesExtractNote: (connectionId: string, path: string) =>
    unwrap(commands.entitiesExtractNote(connectionId, path)),
  entitiesList: () => unwrap(commands.entitiesList()),
  entitiesForNote: (path: string) => unwrap(commands.entitiesForNote(path)),
  entitiesMentions: (entityId: number) => unwrap(commands.entitiesMentions(entityId)),
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
  attendees?: string[];
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
    attendees: d.attendees ?? [],
  };
}
