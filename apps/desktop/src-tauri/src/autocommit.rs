//! Background auto-committer (Git sync P1+P2). A per-vault thread that, every
//! `git.auto_commit_secs` while git sync is enabled, commits pending changes
//! — and, once an `origin` remote is configured, runs the full sync cycle
//! (fetch → fast-forward, push, or auto-merge; merge conflicts stop and only
//! log until the user resolves them). P3b: a conflict-set CHANGE additionally
//! emits [`crate::GitConflictDetected`] so the UI can open the resolver.
//!
//! Lifecycle mirrors the file watcher: the thread is tagged with the
//! generation issued at vault-open (the same [`crate::watcher::WATCH_GEN`]
//! counter) and exits as soon as another vault open (or `close_vault`) bumps
//! it. Prefs are re-read from the vault every tick, so toggling the setting
//! in the UI takes effect without restarting anything.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use novalis_core::git;
use novalis_core::models::GitSyncKind;
use novalis_core::vault::config;

/// Floor for the configured interval — protects against a hand-edited
/// config.json committing on every tick.
const MIN_INTERVAL_SECS: u64 = 30;
/// How often the thread wakes to check generation + elapsed interval.
const TICK: Duration = Duration::from_secs(10);

/// Decide whether a sync outcome's conflict set must be surfaced (warn log +
/// [`crate::GitConflictDetected`] event), updating the `last` latch. A stuck
/// conflict re-surfaces from the cycle every interval (detection is in-memory
/// and cheap) but must not re-emit — only a state CHANGE returns the paths:
/// the first appearance of a set, or a different set than last tick. Any
/// non-conflict outcome resets the latch, so a conflict that returns after a
/// successful cycle surfaces again. `Diverged` (busy repository — the merge
/// was not attempted) leaves the latch untouched: it says nothing about the
/// conflict set.
fn conflict_transition(last: &mut Option<Vec<String>>, kind: &GitSyncKind) -> Option<Vec<String>> {
    match kind {
        GitSyncKind::Conflicted { paths } => {
            if last.as_ref() == Some(paths) {
                None
            } else {
                *last = Some(paths.clone());
                Some(paths.clone())
            }
        }
        GitSyncKind::Diverged => None,
        _ => {
            *last = None;
            None
        }
    }
}

/// Spawn the auto-commit thread for `vault`, tagged with `generation`.
pub fn start(app: AppHandle, vault: PathBuf, generation: u64) {
    std::thread::spawn(move || {
        let mut last_attempt = Instant::now();
        // Conflict paths of the previous tick, when it was Conflicted —
        // see [`conflict_transition`]: warn + emit on state change, debug
        // otherwise.
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
                    Ok(out) => {
                        let changed = conflict_transition(&mut last_conflict, &out.kind);
                        match out.kind {
                            GitSyncKind::UpToDate => {}
                            GitSyncKind::Conflicted { paths } => {
                                if let Some(paths) = changed {
                                    log::warn!(
                                        "git auto-sync: merge conflicts in {} file(s) ({}) — needs manual resolution",
                                        paths.len(),
                                        paths.join(", ")
                                    );
                                    let _ = app.emit(
                                        "git-conflict-detected",
                                        crate::GitConflictDetected { paths },
                                    );
                                } else {
                                    log::debug!(
                                        "git auto-sync: merge conflicts persist in {} file(s)",
                                        paths.len()
                                    );
                                }
                            }
                            GitSyncKind::Diverged => log::warn!(
                                "git auto-sync: histories diverged (ahead {}, behind {}) — needs manual resolution",
                                out.ahead,
                                out.behind
                            ),
                            kind => {
                                log::info!(
                                    "git auto-sync: {kind:?} (ahead {}, behind {})",
                                    out.ahead,
                                    out.behind
                                );
                            }
                        }
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn conflicted(paths: &[&str]) -> GitSyncKind {
        GitSyncKind::Conflicted {
            paths: paths.iter().map(|p| p.to_string()).collect(),
        }
    }

    #[test]
    fn first_conflict_emits_and_latches() {
        let mut last = None;
        let emit = conflict_transition(&mut last, &conflicted(&["a.md"]));
        assert_eq!(emit, Some(vec!["a.md".to_string()]));
        assert_eq!(last, Some(vec!["a.md".to_string()]));
    }

    #[test]
    fn identical_conflict_set_does_not_reemit() {
        let mut last = None;
        assert!(conflict_transition(&mut last, &conflicted(&["a.md"])).is_some());
        assert_eq!(conflict_transition(&mut last, &conflicted(&["a.md"])), None);
        assert_eq!(conflict_transition(&mut last, &conflicted(&["a.md"])), None);
    }

    #[test]
    fn changed_conflict_set_reemits() {
        let mut last = None;
        assert!(conflict_transition(&mut last, &conflicted(&["a.md"])).is_some());
        let emit = conflict_transition(&mut last, &conflicted(&["a.md", "b.md"]));
        assert_eq!(emit, Some(vec!["a.md".to_string(), "b.md".to_string()]));
        assert_eq!(last, Some(vec!["a.md".to_string(), "b.md".to_string()]));
    }

    #[test]
    fn success_resets_the_latch_so_a_returning_conflict_reemits() {
        for success in [
            GitSyncKind::UpToDate,
            GitSyncKind::Pushed,
            GitSyncKind::Pulled,
            GitSyncKind::Merged,
        ] {
            let mut last = None;
            assert!(conflict_transition(&mut last, &conflicted(&["a.md"])).is_some());
            assert_eq!(conflict_transition(&mut last, &success), None);
            assert_eq!(last, None, "{success:?} must reset the latch");
            assert!(
                conflict_transition(&mut last, &conflicted(&["a.md"])).is_some(),
                "same set after {success:?} must re-emit"
            );
        }
    }

    #[test]
    fn diverged_leaves_the_latch_untouched() {
        // Diverged = the merge was not attempted (busy repo); it says nothing
        // about the conflict set, so the same set afterwards stays quiet.
        let mut last = None;
        assert!(conflict_transition(&mut last, &conflicted(&["a.md"])).is_some());
        assert_eq!(conflict_transition(&mut last, &GitSyncKind::Diverged), None);
        assert_eq!(conflict_transition(&mut last, &conflicted(&["a.md"])), None);
    }
}
