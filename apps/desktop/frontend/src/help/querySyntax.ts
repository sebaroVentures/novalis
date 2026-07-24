// The query-DSL syntax table, shared by the Feature Guide's `queryEngine`
// topic (help/registry.ts) and QueryView's empty state.
//
// It lives in its own module for one reason: QueryView is imported EAGERLY by
// App, so reaching into help/registry.ts for these rows pulled the whole
// 700-line registry (and its icon set) into the main bundle — defeating the
// point of loading the guide's catalogs lazily. Row data only, no imports, so
// the eager cost is a few hundred bytes.
//
// `descKey`s are keys into the lazily-loaded `help` namespace; the enumeration
// in help/registry.ts keeps them alive for i18next-parser and
// help/__tests__/registry.test.ts proves they all resolve.
//
// Source: crates/novalis-core/src/index/query.rs lines 1-35 — the full query
// DSL table, mirrored COMPLETELY (one row per term kind + negation).

/** `{ code, descKey }` rows; structurally a `HelpSyntaxRow[]` (registry.ts),
 *  spelled out here to keep this module import-free. */
export const QUERY_SYNTAX: { code: string; descKey: string }[] = [
  { code: 'word "a phrase"', descKey: "topics.queryEngine.syntax.fulltext" },
  { code: "tag:urgent", descKey: "topics.queryEngine.syntax.tag" },
  { code: "folder:Projects", descKey: "topics.queryEngine.syntax.folder" },
  { code: "title:launch", descKey: "topics.queryEngine.syntax.title" },
  { code: "path:2026/", descKey: "topics.queryEngine.syntax.path" },
  { code: "alias:acme", descKey: "topics.queryEngine.syntax.alias" },
  { code: "type:meeting", descKey: "topics.queryEngine.syntax.propEquals" },
  { code: "rating>=4", descKey: "topics.queryEngine.syntax.propCompare" },
  { code: "status!=done", descKey: "topics.queryEngine.syntax.propNotEquals" },
  { code: "project:[[Launch]]", descKey: "topics.queryEngine.syntax.relation" },
  { code: "has:task", descKey: "topics.queryEngine.syntax.hasFacet" },
  { code: "has:deadline", descKey: "topics.queryEngine.syntax.hasProp" },
  { code: "task.status:done", descKey: "topics.queryEngine.syntax.taskStatus" },
  { code: "task.priority:high", descKey: "topics.queryEngine.syntax.taskPriority" },
  { code: "task.due<2026-08-01", descKey: "topics.queryEngine.syntax.taskDue" },
  { code: "task.done:true", descKey: "topics.queryEngine.syntax.taskDone" },
  { code: "sort:modified:desc", descKey: "topics.queryEngine.syntax.sort" },
  { code: 'sort:similarity:"launch"', descKey: "topics.queryEngine.syntax.sortSimilarity" },
  { code: "view:kanban", descKey: "topics.queryEngine.syntax.view" },
  { code: "-tag:archived", descKey: "topics.queryEngine.syntax.negate" },
];
