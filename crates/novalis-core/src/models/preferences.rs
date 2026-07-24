use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    /// Config-format version for one-time migrations. The serde default 0
    /// marks a config written before the feature flags existed (or before the
    /// migration ran); [`crate::vault::config::ensure_features_stamp`] bumps
    /// it. Distinct from the DB SCHEMA_VERSION — this one is vault-synced.
    #[serde(default)]
    pub prefs_version: u32,
    #[serde(default)]
    pub task_view: TaskViewPrefs,
    #[serde(default)]
    pub file_tree: FileTreePrefs,
    #[serde(default)]
    pub appearance: AppearancePrefs,
    #[serde(default)]
    pub editor: EditorPrefs,
    #[serde(default)]
    pub calendar: CalendarPrefs,
    #[serde(default)]
    pub general: GeneralPrefs,
    #[serde(default)]
    pub git: GitPrefs,
    #[serde(default)]
    pub features: FeaturePrefs,
    /// User-named saved queries for the query view. A preference (JSON), synced
    /// with the vault like every block here — never a DB table.
    #[serde(default)]
    pub saved_queries: Vec<crate::models::query::SavedQuery>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskViewPrefs {
    #[serde(default = "default_task_mode")]
    pub default_mode: String,
    #[serde(default = "default_kanban_columns")]
    pub kanban_columns: Vec<KanbanColumnDef>,
    #[serde(default)]
    pub task_creation: TaskCreationPrefs,
    /// Project slug -> color token (e.g. "indigo"), mirroring
    /// [`FileTreePrefs::folder_colors`]. Synced with the vault.
    #[serde(default)]
    pub project_colors: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreationPrefs {
    #[serde(default = "default_creation_strategy")]
    pub strategy: String,
    #[serde(default = "default_inbox_path")]
    pub inbox_path: String,
}

impl TaskCreationPrefs {
    /// Resolve the destination note (vault-relative path) for a newly created
    /// task, given an optional explicit override and the current date.
    pub fn resolve(&self, note_path_override: Option<&str>, today: chrono::NaiveDate) -> String {
        if let Some(path) = note_path_override {
            return path.to_string();
        }
        match self.strategy.as_str() {
            "daily" => format!(
                "journal/{}/{}.md",
                today.format("%Y"),
                today.format("%Y-%m-%d")
            ),
            // "inbox", "active-note" (without override), and any unknown value
            _ => self.inbox_path.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KanbanColumnDef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileTreePrefs {
    /// `"name"` | `"modified"` | `"created"` | `"manual"`.
    #[serde(default = "default_sort_by")]
    pub sort_by: String,
    #[serde(default = "default_sort_dir")]
    pub sort_dir: String,
    /// Folder path (vault-relative, forward-slashed) -> color token (e.g. "indigo").
    /// Synced with the vault so colors follow it across devices.
    #[serde(default)]
    pub folder_colors: HashMap<String, String>,
    /// Parent path ("" = vault root) -> ordered child item keys (folder paths and
    /// note paths, interleaved). Used when `sort_by == "manual"`. Keys never
    /// collide because notes end in `.md`.
    #[serde(default)]
    pub item_order: HashMap<String, Vec<String>>,
}

/// Appearance / theming. `theme` and `density` are applied at runtime by the
/// frontend (CSS variables / `data-*` on the document element); `accent` is a
/// color token shared with the folder-color palette.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppearancePrefs {
    /// `"dark"` | `"light"` | `"system"`.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Accent color token (e.g. `"indigo"`), shared with the folder palette.
    #[serde(default = "default_accent")]
    pub accent: String,
    /// Base UI font size in px.
    #[serde(default = "default_font_size")]
    pub font_size: u8,
    /// `"comfortable"` | `"compact"`.
    #[serde(default = "default_density")]
    pub density: String,
}

/// Editor behavior. Debounce values are milliseconds.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EditorPrefs {
    /// Autosave debounce after the last keystroke.
    #[serde(default = "default_autosave_ms")]
    pub autosave_ms: u32,
    /// Internal serialize/typing-responsiveness debounce (advanced).
    #[serde(default = "default_serialize_ms")]
    pub serialize_ms: u32,
    /// Browser spellcheck in the editor.
    #[serde(default = "default_spellcheck")]
    pub spellcheck: bool,
    /// Open notes in reading mode (rendered, non-editable) by default.
    #[serde(default = "default_reading_mode")]
    pub default_reading_mode: bool,
    /// Ambient AI suggestions: after an edit settles, compute link/tag
    /// suggestions in the background when a provider is configured. Off by
    /// default — the background calls cost tokens, so it is explicit opt-in.
    #[serde(default)]
    pub ambient_ai: bool,
}

/// Calendar display preferences.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarPrefs {
    /// `"monday"` | `"sunday"`.
    #[serde(default = "default_week_start")]
    pub week_start: String,
    /// Default duration (minutes) for a newly created event.
    #[serde(default = "default_event_minutes")]
    pub default_event_minutes: u32,
    /// `"24h"` | `"12h"`.
    #[serde(default = "default_time_format")]
    pub time_format: String,
    /// Minutes before a timed event's start to fire an event-start notification
    /// (`0` = at start). Applied by the frontend reminder poller; calendar
    /// events themselves never carry reminders.
    #[serde(default = "default_event_lead_minutes")]
    pub event_notify_lead_minutes: u32,
}

/// General / startup behavior.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneralPrefs {
    /// View shown on launch: `"notes"` | `"tasks"` | `"calendar"`.
    #[serde(default = "default_app_view")]
    pub default_app_view: String,
}

/// Local git versioning (Git sync P1 — no remotes yet). Synced with the vault
/// like every block here, so enabling follows the vault across devices.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GitPrefs {
    #[serde(default)]
    pub enabled: bool,
    /// Commit author identity — always explicit, never read from the user's
    /// global git config (a machine without one must behave the same).
    #[serde(default = "default_git_author_name")]
    pub author_name: String,
    #[serde(default = "default_git_author_email")]
    pub author_email: String,
    /// Auto-commit interval in seconds; the background committer also
    /// enforces a 30s floor.
    #[serde(default = "default_git_interval_secs")]
    pub auto_commit_secs: u32,
}

/// Feature availability, synced with the vault like every block here. Each
/// flag decides whether a specialized feature's surfaces (rail views, palette
/// commands, panels, editor extensions) exist and whether its background work
/// runs — turning a flag off never deletes data, it only stops the feature.
///
/// The AI family is nested: `ai` is the master switch and a sub-feature is
/// active only when BOTH `ai` and its own flag are true. Three existing gates
/// stay canonical and are deliberately NOT duplicated as flags:
/// [`EditorPrefs::ambient_ai`] (ambient suggestions, under the `ai` master),
/// [`GitPrefs::enabled`] (git sync), and the app-global embedding config
/// (semantic-index enablement).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FeaturePrefs {
    // --- AI family (`ai` is the master; subs require `ai` too) ---
    #[serde(default)]
    pub ai: bool,
    #[serde(default = "default_on")]
    pub ai_meta_suggestions: bool,
    #[serde(default = "default_on")]
    pub ai_templates: bool,
    #[serde(default = "default_on")]
    pub task_extract: bool,
    #[serde(default = "default_on")]
    pub weekly_review: bool,
    #[serde(default = "default_on")]
    pub vault_chat: bool,
    #[serde(default = "default_on")]
    pub related_notes: bool,
    /// Entity extraction spends LLM tokens on ingest, so unlike the other AI
    /// subs it stays an explicit opt-in even once the master is on.
    #[serde(default)]
    pub entity_graph: bool,
    // --- Editor extras ---
    #[serde(default)]
    pub block_refs: bool,
    #[serde(default)]
    pub transclusion: bool,
    #[serde(default)]
    pub mermaid: bool,
    #[serde(default)]
    pub math: bool,
    #[serde(default = "default_on")]
    pub code_highlight: bool,
    #[serde(default = "default_on")]
    pub callouts: bool,
    #[serde(default = "default_on")]
    pub tag_autocomplete: bool,
    #[serde(default = "default_on")]
    pub outline: bool,
    // --- Workspace views (hideable for a notes-only profile, default on) ---
    #[serde(default = "default_on")]
    pub today_view: bool,
    #[serde(default = "default_on")]
    pub tasks: bool,
    #[serde(default = "default_on")]
    pub calendar: bool,
    // --- Power user ---
    #[serde(default)]
    pub plugins: bool,
    #[serde(default)]
    pub query_engine: bool,
    #[serde(default)]
    pub daily_notes: bool,
    #[serde(default = "default_on")]
    pub reminders: bool,
    // --- Knowledge graph ---
    #[serde(default)]
    pub graph_view: bool,
    #[serde(default)]
    pub properties: bool,
    #[serde(default = "default_on")]
    pub backlinks: bool,
    // --- Sync (git sync is gated by `GitPrefs::enabled`) ---
    #[serde(default)]
    pub p2p_sync: bool,
    #[serde(default)]
    pub calendar_sync: bool,
    #[serde(default)]
    pub ics_subscriptions: bool,
    // --- Spatial & media ---
    #[serde(default)]
    pub canvas: bool,
    #[serde(default)]
    pub pdf_annotate: bool,
    #[serde(default)]
    pub voice: bool,
}

fn default_task_mode() -> String {
    "list".to_string()
}

fn default_creation_strategy() -> String {
    "inbox".to_string()
}

fn default_inbox_path() -> String {
    "_Inbox.md".to_string()
}

fn default_sort_by() -> String {
    "name".to_string()
}

fn default_sort_dir() -> String {
    "asc".to_string()
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_accent() -> String {
    "indigo".to_string()
}

fn default_font_size() -> u8 {
    16
}

fn default_density() -> String {
    "comfortable".to_string()
}

fn default_autosave_ms() -> u32 {
    600
}

fn default_serialize_ms() -> u32 {
    200
}

fn default_spellcheck() -> bool {
    true
}

fn default_reading_mode() -> bool {
    false
}

fn default_week_start() -> String {
    "monday".to_string()
}

fn default_event_minutes() -> u32 {
    60
}

fn default_time_format() -> String {
    "24h".to_string()
}

fn default_event_lead_minutes() -> u32 {
    10
}

fn default_app_view() -> String {
    "notes".to_string()
}

fn default_git_author_name() -> String {
    "Novalis".to_string()
}

fn default_git_author_email() -> String {
    "novalis@localhost".to_string()
}

fn default_git_interval_secs() -> u32 {
    300
}

/// Shared default for the feature flags that ship enabled.
fn default_on() -> bool {
    true
}

fn default_kanban_columns() -> Vec<KanbanColumnDef> {
    vec![
        KanbanColumnDef {
            id: "backlog".to_string(),
            title: "Backlog".to_string(),
        },
        KanbanColumnDef {
            id: "todo".to_string(),
            title: "To Do".to_string(),
        },
        KanbanColumnDef {
            id: "in-progress".to_string(),
            title: "In Progress".to_string(),
        },
        KanbanColumnDef {
            id: "review".to_string(),
            title: "Review".to_string(),
        },
        KanbanColumnDef {
            id: "done".to_string(),
            title: "Done".to_string(),
        },
    ]
}

impl Default for TaskViewPrefs {
    fn default() -> Self {
        Self {
            default_mode: default_task_mode(),
            kanban_columns: default_kanban_columns(),
            task_creation: TaskCreationPrefs::default(),
            project_colors: HashMap::new(),
        }
    }
}

impl Default for TaskCreationPrefs {
    fn default() -> Self {
        Self {
            strategy: default_creation_strategy(),
            inbox_path: default_inbox_path(),
        }
    }
}

impl Default for FileTreePrefs {
    fn default() -> Self {
        Self {
            sort_by: default_sort_by(),
            sort_dir: default_sort_dir(),
            folder_colors: HashMap::new(),
            item_order: HashMap::new(),
        }
    }
}

impl Default for AppearancePrefs {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            accent: default_accent(),
            font_size: default_font_size(),
            density: default_density(),
        }
    }
}

impl Default for EditorPrefs {
    fn default() -> Self {
        Self {
            autosave_ms: default_autosave_ms(),
            serialize_ms: default_serialize_ms(),
            spellcheck: default_spellcheck(),
            default_reading_mode: default_reading_mode(),
            ambient_ai: false,
        }
    }
}

impl Default for CalendarPrefs {
    fn default() -> Self {
        Self {
            week_start: default_week_start(),
            default_event_minutes: default_event_minutes(),
            time_format: default_time_format(),
            event_notify_lead_minutes: default_event_lead_minutes(),
        }
    }
}

impl Default for GeneralPrefs {
    fn default() -> Self {
        Self {
            default_app_view: default_app_view(),
        }
    }
}

impl Default for GitPrefs {
    fn default() -> Self {
        Self {
            enabled: false,
            author_name: default_git_author_name(),
            author_email: default_git_author_email(),
            auto_commit_secs: default_git_interval_secs(),
        }
    }
}

impl FeaturePrefs {
    /// Every feature enabled — the legacy profile
    /// [`crate::vault::config::ensure_features_stamp`] writes for vaults that
    /// predate the feature flags, where all of these surfaces were visible.
    pub fn all_on() -> Self {
        Self {
            ai: true,
            ai_meta_suggestions: true,
            ai_templates: true,
            task_extract: true,
            weekly_review: true,
            vault_chat: true,
            related_notes: true,
            entity_graph: true,
            block_refs: true,
            transclusion: true,
            mermaid: true,
            math: true,
            code_highlight: true,
            callouts: true,
            tag_autocomplete: true,
            outline: true,
            today_view: true,
            tasks: true,
            calendar: true,
            plugins: true,
            query_engine: true,
            daily_notes: true,
            reminders: true,
            graph_view: true,
            properties: true,
            backlinks: true,
            p2p_sync: true,
            calendar_sync: true,
            ics_subscriptions: true,
            canvas: true,
            pdf_annotate: true,
            voice: true,
        }
    }
}

impl Default for FeaturePrefs {
    fn default() -> Self {
        Self {
            ai: false,
            ai_meta_suggestions: true,
            ai_templates: true,
            task_extract: true,
            weekly_review: true,
            vault_chat: true,
            related_notes: true,
            entity_graph: false,
            block_refs: false,
            transclusion: false,
            mermaid: false,
            math: false,
            code_highlight: true,
            callouts: true,
            tag_autocomplete: true,
            outline: true,
            today_view: true,
            tasks: true,
            calendar: true,
            plugins: false,
            query_engine: false,
            daily_notes: false,
            reminders: true,
            graph_view: false,
            properties: false,
            backlinks: true,
            p2p_sync: false,
            calendar_sync: false,
            ics_subscriptions: false,
            canvas: false,
            pdf_annotate: false,
            voice: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn day() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 5, 24).unwrap()
    }

    #[test]
    fn resolve_uses_inbox_path_for_inbox_strategy() {
        let prefs = TaskCreationPrefs {
            strategy: "inbox".to_string(),
            inbox_path: "_Inbox.md".to_string(),
        };
        assert_eq!(prefs.resolve(None, day()), "_Inbox.md");
    }

    #[test]
    fn resolve_builds_daily_note_path_for_daily_strategy() {
        let prefs = TaskCreationPrefs {
            strategy: "daily".to_string(),
            inbox_path: "_Inbox.md".to_string(),
        };
        assert_eq!(prefs.resolve(None, day()), "journal/2026/2026-05-24.md");
    }

    #[test]
    fn resolve_prefers_explicit_override() {
        let prefs = TaskCreationPrefs::default();
        assert_eq!(
            prefs.resolve(Some("Projects/Work.md"), day()),
            "Projects/Work.md"
        );
    }

    #[test]
    fn resolve_falls_back_to_inbox_for_active_note_without_override() {
        let prefs = TaskCreationPrefs {
            strategy: "active-note".to_string(),
            inbox_path: "_Inbox.md".to_string(),
        };
        assert_eq!(prefs.resolve(None, day()), "_Inbox.md");
    }

    #[test]
    fn preferences_default_has_expected_new_block_values() {
        let p = Preferences::default();
        assert_eq!(p.appearance.theme, "dark");
        assert_eq!(p.appearance.accent, "indigo");
        assert_eq!(p.appearance.font_size, 16);
        assert_eq!(p.appearance.density, "comfortable");
        assert_eq!(p.editor.autosave_ms, 600);
        assert_eq!(p.editor.serialize_ms, 200);
        assert!(p.editor.spellcheck);
        assert!(!p.editor.default_reading_mode);
        assert!(!p.editor.ambient_ai);
        assert_eq!(p.calendar.week_start, "monday");
        assert_eq!(p.calendar.default_event_minutes, 60);
        assert_eq!(p.calendar.time_format, "24h");
        assert_eq!(p.calendar.event_notify_lead_minutes, 10);
        assert_eq!(p.general.default_app_view, "notes");
    }

    #[test]
    fn deserialize_empty_object_yields_all_defaults() {
        let prefs: Preferences = serde_json::from_str("{}").unwrap();
        assert_eq!(prefs.appearance.theme, "dark");
        assert_eq!(prefs.editor.autosave_ms, 600);
        assert_eq!(prefs.calendar.week_start, "monday");
        assert_eq!(prefs.general.default_app_view, "notes");
    }

    #[test]
    fn git_prefs_default_off_and_legacy_backfilled() {
        let p = Preferences::default();
        assert!(!p.git.enabled);
        assert_eq!(p.git.author_name, "Novalis");
        assert_eq!(p.git.author_email, "novalis@localhost");
        assert_eq!(p.git.auto_commit_secs, 300);
        // A config.json written before the git block existed must backfill it.
        let legacy: Preferences =
            serde_json::from_str(r#"{ "general": { "defaultAppView": "tasks" } }"#).unwrap();
        assert!(!legacy.git.enabled);
        assert_eq!(legacy.git.auto_commit_secs, 300);
    }

    #[test]
    fn deserialize_legacy_config_backfills_new_blocks() {
        // A config.json written before appearance/editor/calendar/general existed
        // must still parse, backfilling the new blocks with defaults.
        let legacy = r#"{
            "taskView": { "defaultMode": "kanban" },
            "fileTree": { "sortBy": "modified" }
        }"#;
        let prefs: Preferences = serde_json::from_str(legacy).unwrap();
        assert_eq!(prefs.task_view.default_mode, "kanban");
        assert_eq!(prefs.file_tree.sort_by, "modified");
        assert_eq!(prefs.appearance.theme, "dark");
        assert_eq!(prefs.calendar.week_start, "monday");
        assert_eq!(prefs.general.default_app_view, "notes");
    }

    #[test]
    fn feature_prefs_defaults_match_the_optionality_plan() {
        let f = Preferences::default().features;
        // Specialized features ship off…
        assert!(!f.ai);
        assert!(!f.entity_graph);
        assert!(!f.block_refs);
        assert!(!f.transclusion);
        assert!(!f.mermaid);
        assert!(!f.math);
        assert!(!f.plugins);
        assert!(!f.query_engine);
        assert!(!f.daily_notes);
        assert!(!f.graph_view);
        assert!(!f.properties);
        assert!(!f.p2p_sync);
        assert!(!f.calendar_sync);
        assert!(!f.ics_subscriptions);
        assert!(!f.canvas);
        assert!(!f.pdf_annotate);
        assert!(!f.voice);
        // …lightweight extras and the pillars ship on. The AI subs are also on:
        // they only take effect once the `ai` master is enabled.
        assert!(f.ai_meta_suggestions);
        assert!(f.ai_templates);
        assert!(f.task_extract);
        assert!(f.weekly_review);
        assert!(f.vault_chat);
        assert!(f.related_notes);
        assert!(f.code_highlight);
        assert!(f.callouts);
        assert!(f.tag_autocomplete);
        assert!(f.outline);
        assert!(f.today_view);
        assert!(f.tasks);
        assert!(f.calendar);
        assert!(f.reminders);
        assert!(f.backlinks);
    }

    #[test]
    fn legacy_config_backfills_feature_prefs() {
        // A config.json written before the features block existed must
        // backfill it with the defaults above.
        let legacy: Preferences =
            serde_json::from_str(r#"{ "general": { "defaultAppView": "tasks" } }"#).unwrap();
        assert!(!legacy.features.ai);
        assert!(!legacy.features.canvas);
        assert!(legacy.features.tasks);
        assert!(legacy.features.outline);
        // A partial features block backfills only the missing flags.
        let partial: Preferences =
            serde_json::from_str(r#"{ "features": { "canvas": true, "outline": false } }"#)
                .unwrap();
        assert!(partial.features.canvas);
        assert!(!partial.features.outline);
        assert!(!partial.features.ai);
        assert!(partial.features.calendar);
    }

    #[test]
    fn feature_prefs_roundtrip_through_json() {
        let mut p = Preferences::default();
        p.features.ai = true;
        p.features.vault_chat = false;
        p.features.canvas = true;
        p.features.tasks = false;
        let json = serde_json::to_string(&p).unwrap();
        // Wire names are camelCase like every other block.
        assert!(json.contains("\"aiMetaSuggestions\""));
        assert!(json.contains("\"pdfAnnotate\""));
        let back: Preferences = serde_json::from_str(&json).unwrap();
        assert!(back.features.ai);
        assert!(!back.features.vault_chat);
        assert!(back.features.canvas);
        assert!(!back.features.tasks);
        assert!(back.features.reminders);
    }

    #[test]
    fn appearance_roundtrips_through_json() {
        let mut p = Preferences::default();
        p.appearance.theme = "light".to_string();
        p.appearance.accent = "emerald".to_string();
        p.appearance.font_size = 17;
        p.calendar.time_format = "12h".to_string();
        let json = serde_json::to_string(&p).unwrap();
        let back: Preferences = serde_json::from_str(&json).unwrap();
        assert_eq!(back.appearance.theme, "light");
        assert_eq!(back.appearance.accent, "emerald");
        assert_eq!(back.appearance.font_size, 17);
        assert_eq!(back.calendar.time_format, "12h");
    }
}
