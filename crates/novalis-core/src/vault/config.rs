//! Vault path / data-dir helpers and per-vault preferences.
//!
//! The vault path itself comes from the app's settings store (resolved in the
//! Tauri shell), not from environment variables. Per-vault preferences live in
//! a hidden `.novalis/` folder inside the vault (Obsidian-style, synced),
//! while the search index and trash live in the OS app-data `data_dir`
//! (never synced).

use std::path::{Path, PathBuf};

use crate::error::{CoreError, CoreResult};
use crate::models::Preferences;

/// Per-vault config folder (synced with the vault).
pub const CONFIG_DIR: &str = ".novalis";
/// Preferences file inside [`CONFIG_DIR`].
pub const PREFS_FILE: &str = "config.json";

/// Ensure the vault directory exists, creating it if necessary.
pub fn ensure_vault_dir(path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        std::fs::create_dir_all(path)?;
        log::info!("created vault directory at {}", path.display());
    }
    Ok(())
}

/// Ensure the app-data support dirs exist (`templates`, `db`). Trash now lives
/// inside the vault (`.novalis/trash`); `versions/` is created lazily on save.
pub fn ensure_data_dirs(data_dir: &Path) -> std::io::Result<()> {
    for d in ["templates", "db"] {
        let p = data_dir.join(d);
        if !p.exists() {
            std::fs::create_dir_all(&p)?;
        }
    }
    Ok(())
}

/// Path to the SQLite index database within `data_dir`.
pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("db").join("notes.db")
}

/// The `.novalis/` config directory inside a vault.
pub fn config_dir(vault: &Path) -> PathBuf {
    vault.join(CONFIG_DIR)
}

fn prefs_path(vault: &Path) -> PathBuf {
    config_dir(vault).join(PREFS_FILE)
}

/// Read preferences from `<vault>/.novalis/config.json`. A missing file is
/// legitimate (fresh vault) and yields defaults; an unreadable or malformed
/// file is an error — silently defaulting here meant one bad edit plus any
/// later [`write_preferences`] permanently replaced the user's file.
pub fn try_read_preferences(vault: &Path) -> CoreResult<Preferences> {
    let path = prefs_path(vault);
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|e| CoreError::Serde(format!("{}: {e}", path.display()))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(e) => Err(e.into()),
    }
}

/// Write preferences to `<vault>/.novalis/config.json`, creating the dir.
pub fn write_preferences(vault: &Path, prefs: &Preferences) -> CoreResult<()> {
    let dir = config_dir(vault);
    std::fs::create_dir_all(&dir)?;
    let json = serde_json::to_string_pretty(prefs).map_err(|e| CoreError::Serde(e.to_string()))?;
    crate::vault::fs::write_atomic(&dir.join(PREFS_FILE), &json)?;
    Ok(())
}

/// The config-format version [`ensure_features_stamp`] migrates to.
pub const PREFS_VERSION: u32 = 1;

/// Outcome of [`ensure_features_stamp`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeaturesStamp {
    /// Config already migrated — nothing written (the every-open fast path).
    Current,
    /// Version stamped; the features block was kept (or is the lean default
    /// on an empty/new vault). No index impact.
    Stamped,
    /// Legacy vault: the all-on profile was written. The caller should run a
    /// FULL index rebuild — ingest passes skipped while the vault ran on the
    /// lean defaults (block refs) left the index wiped or stale, and the
    /// incremental mtime scan would never repair it.
    StampedLegacy,
}

/// One-time feature-flags migration, run on every vault open: a vault whose
/// config predates the `features` block (or whose block was only materialized
/// incidentally by a flags-era settings save, still bit-identical to the lean
/// serde defaults) would silently LOSE surfaces it was using. While
/// `prefs_version` is 0:
///
/// - a vault WITH content and no deliberately changed features block →
///   [`crate::models::FeaturePrefs::all_on`], exactly the pre-flags behavior
///   where every surface existed;
/// - a features block that differs from the lean defaults was user-chosen in
///   Settings › Features → kept as-is;
/// - an empty vault is new → the lean defaults stay.
///
/// Either way `prefs_version` is bumped, so the migration runs exactly once
/// per vault and a later deliberate return to the default flags can never
/// snap back to all-on. A malformed config (including `features: null`) is a
/// loud error and nothing is written (same contract as
/// [`try_read_preferences`] — never clobber a user's file).
pub fn ensure_features_stamp(vault: &Path) -> CoreResult<FeaturesStamp> {
    let path = prefs_path(vault);
    let (existing, had_features) = match std::fs::read_to_string(&path) {
        Ok(contents) => {
            let value: serde_json::Value = serde_json::from_str(&contents)
                .map_err(|e| CoreError::Serde(format!("{}: {e}", path.display())))?;
            let had_features = value.get("features").is_some();
            // Full parse through the typed struct — a `features: null` or
            // scalar fails HERE, loudly, before anything is written.
            let prefs = serde_json::from_value::<Preferences>(value)
                .map_err(|e| CoreError::Serde(format!("{}: {e}", path.display())))?;
            (prefs, had_features)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Preferences::default(), false),
        Err(e) => return Err(e.into()),
    };

    if existing.prefs_version >= PREFS_VERSION {
        return Ok(FeaturesStamp::Current);
    }

    let mut prefs = existing;
    prefs.prefs_version = PREFS_VERSION;
    let chosen = had_features && prefs.features != crate::models::FeaturePrefs::default();
    let outcome = if !chosen && vault_has_content(vault) {
        log::info!(
            "vault predates the feature flags — enabling the legacy all-on profile: {}",
            vault.display()
        );
        prefs.features = crate::models::FeaturePrefs::all_on();
        FeaturesStamp::StampedLegacy
    } else {
        FeaturesStamp::Stamped
    };
    write_preferences(vault, &prefs)?;
    Ok(outcome)
}

/// Whether the vault holds any user file at all (notes, canvases, PDFs, … —
/// including trashed ones under `.novalis/trash`, which are one restore away
/// from being content). Other hidden entries don't count; empty folders don't
/// either. An UNREADABLE directory counts as content: when we cannot rule
/// content out, the migration must err toward keeping surfaces (all-on), not
/// silently going lean.
fn vault_has_content(vault: &Path) -> bool {
    fn walk(dir: &Path) -> bool {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
            Err(_) => return true,
        };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            match entry.file_type() {
                Ok(t) if t.is_dir() => {
                    if walk(&entry.path()) {
                        return true;
                    }
                }
                Ok(t) if t.is_file() => return true,
                _ => {}
            }
        }
        false
    }
    walk(vault) || walk(&config_dir(vault).join("trash"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_prefs_file_yields_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let prefs = try_read_preferences(dir.path()).unwrap();
        assert_eq!(
            serde_json::to_value(&prefs).unwrap(),
            serde_json::to_value(Preferences::default()).unwrap()
        );
    }

    #[test]
    fn malformed_prefs_file_is_an_error_not_a_silent_default() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config_dir(dir.path());
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(cfg.join(PREFS_FILE), "{ not json").unwrap();
        let err = try_read_preferences(dir.path()).unwrap_err();
        assert!(matches!(err, CoreError::Serde(_)), "got: {err:?}");
    }

    /// Tempdirs are named `.tmp…`; vaults must be non-hidden subdirs or the
    /// content walk (like the note walker) would skip them.
    fn vault_in(base: &tempfile::TempDir) -> PathBuf {
        let vault = base.path().join("Vault");
        std::fs::create_dir_all(&vault).unwrap();
        vault
    }

    #[test]
    fn stamp_gives_a_legacy_vault_with_content_the_all_on_profile() {
        let base = tempfile::tempdir().unwrap();
        let vault = vault_in(&base);
        std::fs::write(vault.join("n.md"), "existing note").unwrap();
        // A pre-flags config: has settings, no `features` key, version 0.
        let mut prefs = Preferences::default();
        prefs.general.default_app_view = "tasks".to_string();
        let mut value = serde_json::to_value(&prefs).unwrap();
        value.as_object_mut().unwrap().remove("features");
        value.as_object_mut().unwrap().remove("prefsVersion");
        let cfg = config_dir(&vault);
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(cfg.join(PREFS_FILE), value.to_string()).unwrap();

        assert_eq!(
            ensure_features_stamp(&vault).unwrap(),
            FeaturesStamp::StampedLegacy
        );

        let back = try_read_preferences(&vault).unwrap();
        // Legacy vaults keep every surface they had…
        assert!(back.features.canvas);
        assert!(back.features.ai);
        assert!(back.features.block_refs);
        // …and their other settings.
        assert_eq!(back.general.default_app_view, "tasks");
        assert_eq!(back.prefs_version, PREFS_VERSION);
        // Migrated: the second run is a no-op.
        assert_eq!(
            ensure_features_stamp(&vault).unwrap(),
            FeaturesStamp::Current
        );
    }

    #[test]
    fn stamp_treats_a_content_vault_without_any_config_as_legacy() {
        let base = tempfile::tempdir().unwrap();
        let vault = vault_in(&base);
        std::fs::create_dir_all(vault.join("sub")).unwrap();
        std::fs::write(vault.join("sub").join("deep.md"), "note").unwrap();

        assert_eq!(
            ensure_features_stamp(&vault).unwrap(),
            FeaturesStamp::StampedLegacy
        );
        assert!(try_read_preferences(&vault).unwrap().features.graph_view);
    }

    #[test]
    fn stamp_rescues_an_incidentally_lean_flags_era_config() {
        // The gap population: a legacy vault that saved SOME setting under a
        // flags-era build, materializing a features block bit-identical to the
        // lean defaults (never a user choice) at version 0.
        let base = tempfile::tempdir().unwrap();
        let vault = vault_in(&base);
        std::fs::write(vault.join("n.md"), "note").unwrap();
        let mut prefs = Preferences {
            prefs_version: 0,
            ..Default::default()
        };
        prefs.appearance.theme = "light".to_string(); // the incidental save
        write_preferences(&vault, &prefs).unwrap();

        assert_eq!(
            ensure_features_stamp(&vault).unwrap(),
            FeaturesStamp::StampedLegacy
        );
        let back = try_read_preferences(&vault).unwrap();
        assert!(back.features.canvas);
        assert_eq!(back.appearance.theme, "light");
    }

    #[test]
    fn stamp_gives_an_empty_vault_the_lean_defaults() {
        let base = tempfile::tempdir().unwrap();
        let vault = vault_in(&base);
        // Hidden config dir and empty folders don't count as content.
        std::fs::create_dir_all(config_dir(&vault)).unwrap();
        std::fs::create_dir_all(vault.join("empty-folder")).unwrap();

        assert_eq!(
            ensure_features_stamp(&vault).unwrap(),
            FeaturesStamp::Stamped
        );

        let back = try_read_preferences(&vault).unwrap();
        assert!(!back.features.canvas);
        assert!(back.features.tasks);
        // Versioned now, so filling the vault later can't re-trigger the
        // legacy migration.
        std::fs::write(vault.join("later.md"), "note").unwrap();
        assert_eq!(
            ensure_features_stamp(&vault).unwrap(),
            FeaturesStamp::Current
        );
        assert!(!try_read_preferences(&vault).unwrap().features.canvas);
    }

    #[test]
    fn stamp_keeps_a_deliberately_changed_features_block() {
        let base = tempfile::tempdir().unwrap();
        let vault = vault_in(&base);
        std::fs::write(vault.join("n.md"), "note").unwrap();
        let mut prefs = Preferences {
            prefs_version: 0,
            ..Default::default()
        };
        prefs.features.canvas = true; // differs from the defaults = chosen
        write_preferences(&vault, &prefs).unwrap();

        assert_eq!(
            ensure_features_stamp(&vault).unwrap(),
            FeaturesStamp::Stamped
        );
        let back = try_read_preferences(&vault).unwrap();
        assert!(back.features.canvas);
        assert!(!back.features.ai);
        assert_eq!(back.prefs_version, PREFS_VERSION);
    }

    #[test]
    fn stamp_counts_trashed_notes_as_content() {
        // A legacy vault whose every note sits in the in-vault trash is one
        // restore away from being content — it must get the legacy profile.
        let base = tempfile::tempdir().unwrap();
        let vault = vault_in(&base);
        let trash = config_dir(&vault).join("trash");
        std::fs::create_dir_all(&trash).unwrap();
        std::fs::write(trash.join("n.md"), "trashed note").unwrap();

        assert_eq!(
            ensure_features_stamp(&vault).unwrap(),
            FeaturesStamp::StampedLegacy
        );
    }

    #[test]
    fn stamp_never_clobbers_a_malformed_config() {
        let base = tempfile::tempdir().unwrap();
        let vault = vault_in(&base);
        std::fs::write(vault.join("n.md"), "note").unwrap();
        let cfg = config_dir(&vault);
        std::fs::create_dir_all(&cfg).unwrap();
        for bad in [
            "{ not json",
            r#"{ "features": null }"#,
            r#"{ "features": 7 }"#,
        ] {
            std::fs::write(cfg.join(PREFS_FILE), bad).unwrap();
            let err = ensure_features_stamp(&vault).unwrap_err();
            assert!(matches!(err, CoreError::Serde(_)), "{bad}: got {err:?}");
            // The broken file is exactly as the user left it.
            assert_eq!(std::fs::read_to_string(cfg.join(PREFS_FILE)).unwrap(), bad);
        }
    }
}
