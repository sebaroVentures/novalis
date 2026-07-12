use serde::{Deserialize, Serialize};
use specta::Type;

/// A full note: raw markdown `content` (frontmatter included) plus a parsed view.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub path: String,
    pub title: String,
    pub content: String,
    pub frontmatter: NoteFrontmatter,
    pub word_count: usize,
    /// Typed view of the custom frontmatter keys (the `extra` passthrough),
    /// in the alphabetical order serde_yaml re-emits them. Derived on read —
    /// the YAML stays the source of truth.
    #[serde(default)]
    pub properties: Vec<NotePropertyEntry>,
}

/// The typed value of one custom frontmatter property — a closed wire enum
/// over the YAML shapes the properties panel can edit. Anything else a user
/// hand-wrote (nested maps, mixed-type arrays, integers beyond f64's exact
/// range) is surfaced as `Text` by the read mapper and only overwritten by an
/// explicit edit.
///
/// `Number` is `Option` because JSON cannot carry NaN/Infinity — a frontend
/// `NaN` arrives over IPC as `null`, and it must surface as a structured
/// `BadRequest` from the write boundary rather than an opaque deserialization
/// failure. The read mapper never produces `None`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum PropertyValue {
    Text(String),
    Number(Option<f64>),
    Checkbox(bool),
    List(Vec<String>),
}

/// One custom frontmatter key/value pair, surfaced on [`Note`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotePropertyEntry {
    pub key: String,
    pub value: PropertyValue,
}

/// One end of a typed relation between two notes, as seen from the other note:
/// the note at `path`/`title`, reached via the property `key` that declared the
/// relation. Used for both the outgoing and (reciprocal) incoming directions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RelationRef {
    pub path: String,
    pub title: String,
    pub key: String,
}

/// A note's typed relations in both directions. `outgoing` are the notes this
/// note's frontmatter points to; `incoming` are the notes whose frontmatter
/// points here — the reciprocal side, derived from the same `note_relations`
/// rows (one forward row per relation serves both queries).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteRelations {
    pub outgoing: Vec<RelationRef>,
    pub incoming: Vec<RelationRef>,
}

/// A numeric aggregation over the notes a relation points to. The
/// data-layer primitive a future query engine's "rollup" columns build on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RollupOp {
    Count,
    Sum,
    Avg,
    Min,
    Max,
}

/// The result of a rollup: `count` is how many related notes contributed a
/// numeric value; `value` is the aggregate, or `None` when it is undefined
/// (`Avg`/`Min`/`Max` over an empty set). `Count`/`Sum` are always defined.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RollupResult {
    pub op: RollupOp,
    pub count: usize,
    pub value: Option<f64>,
}

/// YAML frontmatter. Field names are the literal YAML keys (no camelCase). The
/// `extra` map preserves any unknown keys verbatim so we never drop a user's
/// metadata on round-trip; it's skipped from the TS type as it is open-ended.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct NoteFrontmatter {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub created: String,
    #[serde(default)]
    pub modified: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(flatten)]
    #[specta(skip)]
    pub extra: serde_json::Value,
}

/// Lightweight note metadata used for lists, the file tree, and search results.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub path: String,
    pub title: String,
    pub folder: String,
    pub tags: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub created: String,
    pub modified: String,
    pub pinned: bool,
    pub word_count: usize,
    pub task_total: usize,
    pub task_completed: usize,
    /// True for an "online only" cloud placeholder (OneDrive/iCloud) whose
    /// content isn't on disk yet, so opening it triggers a network download.
    pub cloud_only: bool,
}

/// One matching line within a note that links to or mentions a target title.
/// `line` is 1-based and refers to the raw file (frontmatter included), so it
/// can locate the line again for [`crate::notes::link_mention`].
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkMatch {
    pub line: usize,
    pub snippet: String,
}

/// A note that references a target title, grouped with the lines where it does.
/// Used for the "linked references" and "unlinked mentions" panels.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinkReference {
    pub path: String,
    pub title: String,
    pub folder: String,
    pub modified: String,
    pub matches: Vec<LinkMatch>,
}

/// A node (note) in the local link graph.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub path: String,
    pub title: String,
}

/// A directed `[[link]]` edge between two notes, by path.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

/// The 1-hop link neighborhood of a note: the note itself (`center`), the notes
/// it links to, and the notes that link to it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NoteGraph {
    pub center: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// A node in the whole-vault graph. A parallel type (not a widened
/// [`GraphNode`], which `note_graph` still serves) — the vault view colors
/// nodes by folder, so it carries one extra field.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultGraphNode {
    pub path: String,
    pub title: String,
    pub folder: String,
}

/// The whole-vault link graph: every indexed note plus every resolved
/// `[[link]]` edge between two existing notes.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FullGraph {
    pub nodes: Vec<VaultGraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteRequest {
    pub path: String,
    pub content: Option<String>,
    pub template: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetaRequest {
    pub path: Option<String>,
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub pinned: Option<bool>,
    pub aliases: Option<Vec<String>>,
}

/// What an `![[embed]]` target resolved to. A note renders its body inline; an
/// image renders via the host's `resolveImageSrc`; a miss reports `Missing` so
/// the UI can offer a "create note" affordance — unlike `[[wikilinks]]`, embeds
/// never materialize a note on miss.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EmbedTargetKind {
    Note,
    Image,
    Missing,
}

/// The resolution of an `![[embed]]` reference. `path`/`title`/`body` are set
/// for a `Note` hit (`body` has the frontmatter stripped); all `None` for a
/// `Missing` target. `Image` is classified frontend-side by extension, so the
/// backend only ever returns `Note` or `Missing`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EmbedResolution {
    pub kind: EmbedTargetKind,
    pub path: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
}

/// One indexed block (a line tagged with a stable ` ^id` marker) surfaced to the
/// `((` reference autocomplete. `text` has the marker stripped.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlockHit {
    pub id: String,
    pub note_path: String,
    pub note_title: String,
    pub text: String,
}

/// The resolution of a `((^id))` block reference. `notePath`/`noteTitle`/`text`
/// are set when `found`; all `None`/`false` for a dangling id (its block was
/// deleted). Unlike `[[wikilinks]]`, a block reference never materializes
/// anything on a miss — a broken reference simply renders as "missing".
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlockResolution {
    pub found: bool,
    pub note_path: Option<String>,
    pub note_title: Option<String>,
    pub text: Option<String>,
}
