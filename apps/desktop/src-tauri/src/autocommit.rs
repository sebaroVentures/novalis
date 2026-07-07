//! Background auto-committer (Git sync P1+P2). A per-vault thread that, every
//! `git.auto_commit_secs` while git sync is enabled, commits pending changes
//! — and, once an `origin` remote is configured, runs the full sync cycle
//! (fetch → fast-forward, push, or auto-merge; merge conflicts stop and only
//! log until the user resolves them).
//!
//! Lifecycle mirrors the file watcher: the thread is tagged with the
//! generation issued at vault-open (the same [`crate::watcher::WATCH_GEN`]
//! counter) and exits as soon as another vault open (or `close_vault`) bumps
//! it. Prefs are re-read from the vault every tick, so toggling the setting
//! in the UI takes effect without restarting anything.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use novalis_core::git;
use novalis_core::models::GitSyncKind;
use novalis_core::vault::config;

/// Floor for the configured interval — protects against a hand-edited
/// config.json committing on every tick.
const MIN_INTERVAL_SECS: u64 = 30;
/// How often the thread wakes to check generation + elapsed interval.
const TICK: Duration = Duration::from_secs(10);

/// Spawn the auto-commit thread for `vault`, tagged with `generation`.
pub fn start(vault: PathBuf, generation: u64) {
    std::thread::spawn(move || {
        let mut last_attempt = Instant::now();
        // Conflict paths of the previous tick, when it was Conflicted. A
        // stuck conflict re-surfaces every interval (the cycle re-attempts
        // and that's fine — detection is in-memory and cheap), but it must
        // not spam warnings: warn on state change, debug otherwise.
        let mut last_conflict: Option<Vec<String>> = None;
        loop {
            std::thread::sleep(TICK);
            if crate::watcher::WATCH_GEN.load(Ordering::SeqCst) != generation {
                break;
            }
            // A corrupt config must not auto-commit with default settings —
            // skip the tick and keep warning until the user fixes the file.
            let prefs = match config::try_read_preferences(&vault) {
                Ok(prefs) => prefs,
                Err(e) => {
                    log::warn!("auto-commit: unreadable preferences, skipping tick: {e}");
                    continue;
                }
            };
            if !prefs.git.enabled {
                continue;
            }
            let interval = u64::from(prefs.git.auto_commit_secs).max(MIN_INTERVAL_SECS);
            if last_attempt.elapsed() < Duration::from_secs(interval) {
                continue;
            }
            last_attempt = Instant::now();
            if git::has_remote(&vault) {
                let token = crate::commands::read_git_token(&vault);
                let result = git::sync(
                    &vault,
                    &prefs.git.author_name,
                    &prefs.git.author_email,
                    token.as_deref(),
                );
                match result {
                    Ok(out) => match out.kind {
                        GitSyncKind::UpToDate => last_conflict = None,
                        GitSyncKind::Conflicted { paths } => {
                            if last_conflict.as_ref() == Some(&paths) {
                                log::debug!(
                                    "git auto-sync: merge conflicts persist in {} file(s)",
                                    paths.len()
                                );
                            } else {
                                log::warn!(
                                    "git auto-sync: merge conflicts in {} file(s) ({}) — needs manual resolution",
                                    paths.len(),
                                    paths.join(", ")
                                );
                                last_conflict = Some(paths);
                            }
                        }
                        GitSyncKind::Diverged => log::warn!(
                            "git auto-sync: histories diverged (ahead {}, behind {}) — needs manual resolution",
                            out.ahead,
                            out.behind
                        ),
                        kind => {
                            last_conflict = None;
                            log::info!(
                                "git auto-sync: {kind:?} (ahead {}, behind {})",
                                out.ahead,
                                out.behind
                            );
                        }
                    },
                    Err(e) => log::warn!("git auto-sync failed: {e}"),
                }
            } else {
                let result = git::ensure_repo(&vault).and_then(|()| {
                    git::commit_all(&vault, &prefs.git.author_name, &prefs.git.author_email)
                });
                match result {
                    Ok(Some(c)) => {
                        log::info!(
                            "git auto-commit {}: {}",
                            &c.id[..7.min(c.id.len())],
                            c.message
                        )
                    }
                    Ok(None) => {}
                    Err(e) => log::warn!("git auto-commit failed: {e}"),
                }
            }
        }
        log::info!("git auto-committer for {} stopped", vault.display());
    });
}
