//! Git versioning + sync for a vault. P1: local auto-commit. P2a: HTTPS
//! remote sync (fetch → fast-forward or push). P2b: automatic 3-way merge
//! when histories truly diverge — conflicts stop the cycle without touching
//! the working tree, and force-pushing is never an option.
//!
//! Every function opens the repository per call: `git2::Repository` is
//! `!Sync`, per-call opens are cheap at auto-commit rates, and it keeps this
//! module free of shared state. The workspace builds git2 with https as the
//! ONLY network transport (no ssh/libssh2 — engine-spike sign-off); auth is
//! PAT-over-HTTPS via attempt-bounded callbacks.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use git2::build::CheckoutBuilder;
use git2::{
    Cred, FetchOptions, IndexAddOption, Oid, PushOptions, RemoteCallbacks, Repository,
    RepositoryInitOptions, Signature, StatusOptions,
};

use crate::error::{CoreError, CoreResult};
use crate::models::{GitCommitInfo, GitStatus, GitSyncKind, GitSyncOutcome};

/// Lines Novalis maintains in the vault's `.gitignore`. `.novalis/config.json`
/// is deliberately NOT ignored — per-vault preferences are synced-by-design
/// (they already travel with OneDrive-style vault sync); trash and version
/// snapshots are local safety nets that would only bloat history.
const IGNORE_LINES: [&str; 3] = [".novalis/trash/", ".novalis/versions/", ".DS_Store"];

/// Serializes every mutating git operation in this process — the manual
/// "commit now" command and the background auto-committer would otherwise
/// race each other at `.git/index.lock` and surface spurious lock errors.
/// Cross-process contention (the user's own git CLI) still errors; that one
/// is real.
static MUTATE_GATE: Mutex<()> = Mutex::new(());

/// Serializes whole sync cycles (manual "sync now" vs the background
/// auto-committer). Deliberately separate from [`MUTATE_GATE`]: the network
/// phases (fetch/push) run under THIS gate only, so a slow or hung remote
/// can never block local auto-commits or the commit-now button. Lock order
/// is always SYNC_GATE → MUTATE_GATE, never the reverse.
static SYNC_GATE: Mutex<()> = Mutex::new(());

/// Bound libgit2's network I/O once per process — it ships with NO default
/// timeouts, so a hung remote would otherwise stall a sync cycle (and the
/// background thread waiting on [`SYNC_GATE`]) forever.
fn ensure_network_timeouts() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        let _ = git2::opts::set_server_connect_timeout_in_milliseconds(15_000);
        let _ = git2::opts::set_server_timeout_in_milliseconds(60_000);
    });
}

/// A `.git` lock file older than this has no live owner: in-process holders
/// are serialized by [`MUTATE_GATE`] and finish in seconds. Crashed/killed
/// processes leave their locks behind, and libgit2 never cleans them up —
/// without this, one power loss mid-commit kills versioning permanently.
const STALE_LOCK_AGE: Duration = Duration::from_secs(600);

fn gerr(e: git2::Error) -> CoreError {
    CoreError::Internal(format!("git: {}", e.message()))
}

/// Open the repository rooted exactly at `vault` (no upward discovery — a
/// vault inside some larger repo is treated as not initialized, and enabling
/// creates a nested repo scoped to the vault).
fn open(vault: &Path) -> Option<Repository> {
    Repository::open(vault).ok()
}

/// Ensure `vault` is a git repository and Novalis' ignore entries exist.
/// Initializes with `main` as the initial HEAD — libgit2 otherwise defaults
/// to an unborn `master`, which breaks pushing `refs/heads/main` later.
/// Also clears crash-orphaned lock files. Idempotent; preserves a
/// user-authored `.gitignore`.
pub fn ensure_repo(vault: &Path) -> CoreResult<()> {
    let _gate = MUTATE_GATE.lock().unwrap_or_else(|p| p.into_inner());
    if open(vault).is_none() {
        let mut opts = RepositoryInitOptions::new();
        opts.initial_head("main");
        Repository::init_opts(vault, &opts).map_err(gerr)?;
    }
    // Novalis reads and writes every note as LF on all platforms. Pin
    // core.autocrlf=false on the vault repo so libgit2 never rewrites line
    // endings on checkout: Git for Windows defaults autocrlf=true, which would
    // turn a pulled `\n` into `\r\n` in the working tree — diverging byte-for-byte
    // from macOS/Linux clones and leaving the auto-committer a perpetually
    // "modified" tree.
    if let Some(repo) = open(vault) {
        repo.config()
            .and_then(|mut cfg| cfg.set_bool("core.autocrlf", false))
            .map_err(gerr)?;
    }
    remove_stale_locks(vault, STALE_LOCK_AGE);
    ensure_ignores(vault)
}

/// Remove `.git` lock files left behind by a crashed/killed process. Only
/// locks older than `max_age` go — a fresh lock is live contention (e.g. the
/// user's own git CLI) and must be respected. Best-effort: failures only log,
/// the subsequent commit surfaces the real error.
fn remove_stale_locks(vault: &Path, max_age: Duration) {
    let git_dir = vault.join(".git");
    let mut candidates = vec![git_dir.join("index.lock"), git_dir.join("HEAD.lock")];
    if let Ok(heads) = std::fs::read_dir(git_dir.join("refs/heads")) {
        candidates.extend(
            heads
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "lock")),
        );
    }
    for lock in candidates {
        let Ok(meta) = lock.symlink_metadata() else {
            continue;
        };
        let stale = meta
            .modified()
            .ok()
            .and_then(|m| m.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if stale {
            match std::fs::remove_file(&lock) {
                Ok(()) => log::warn!("git: removed stale lock {}", lock.display()),
                Err(e) => log::warn!("git: cannot remove stale lock {}: {e}", lock.display()),
            }
        }
    }
}

/// Append any missing [`IGNORE_LINES`] to the vault's `.gitignore`, creating
/// the file if absent. Operates on raw bytes so a user-authored file in a
/// non-UTF-8 encoding (e.g. Latin-1 comments) is appended to — never
/// rewritten, reordered, or destroyed.
fn ensure_ignores(vault: &Path) -> CoreResult<()> {
    let path = vault.join(".gitignore");
    let existing: Vec<u8> = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    let has_line = |wanted: &str| {
        existing
            .split(|b| *b == b'\n')
            .any(|line| line.trim_ascii() == wanted.as_bytes())
    };
    let missing: Vec<&str> = IGNORE_LINES
        .iter()
        .copied()
        .filter(|wanted| !has_line(wanted))
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    let mut out = existing;
    if !out.is_empty() && !out.ends_with(b"\n") {
        out.push(b'\n');
    }
    out.extend_from_slice(missing.join("\n").as_bytes());
    out.push(b'\n');
    std::fs::write(&path, out)?;
    Ok(())
}

/// Repository state for the UI. `initialized: false` (all else empty) when
/// the vault is not a repo — callers treat that as "git sync not set up",
/// not as an error.
pub fn repo_status(vault: &Path) -> CoreResult<GitStatus> {
    let Some(repo) = open(vault) else {
        return Ok(GitStatus {
            initialized: false,
            dirty: 0,
            branch: None,
            last_commit: None,
            remote_url: None,
            ahead: 0,
            behind: 0,
        });
    };
    let branch = current_branch(&repo);
    // Ahead/behind against the remote-tracking ref — local refs only (no
    // network), so it reflects the state as of the last fetch.
    let local = repo
        .find_reference(&format!("refs/heads/{branch}"))
        .ok()
        .and_then(|r| r.target());
    let remote_tip = repo
        .find_reference(&format!("refs/remotes/origin/{branch}"))
        .ok()
        .and_then(|r| r.target());
    let (ahead, behind) = match (local, remote_tip) {
        (Some(l), Some(r)) => repo
            .graph_ahead_behind(l, r)
            .map(|(a, b)| (a as u32, b as u32))
            .unwrap_or((0, 0)),
        _ => (0, 0),
    };
    Ok(GitStatus {
        initialized: true,
        dirty: count_dirty(&repo)?,
        branch: Some(branch),
        last_commit: head_commit_info(&repo),
        remote_url: remote_url(&repo),
        ahead,
        behind,
    })
}

fn remote_url(repo: &Repository) -> Option<String> {
    let remote = repo.find_remote("origin").ok()?;
    remote.url().ok().map(str::to_string)
}

/// Whether an `origin` remote is configured — cheap (no status scan), for
/// the auto-committer's per-tick "sync or just commit?" decision.
pub fn has_remote(vault: &Path) -> bool {
    open(vault).is_some_and(|r| r.find_remote("origin").is_ok())
}

/// HEAD branch shorthand; falls back to the symbolic HEAD target for an
/// unborn branch (fresh repo before the first commit).
fn current_branch(repo: &Repository) -> String {
    if let Ok(head) = repo.head() {
        if let Ok(name) = head.shorthand() {
            return name.to_string();
        }
    }
    repo.find_reference("HEAD")
        .ok()
        .and_then(|h| h.symbolic_target().ok().flatten().map(str::to_string))
        .and_then(|t| t.strip_prefix("refs/heads/").map(str::to_string))
        .unwrap_or_else(|| "main".to_string())
}

/// Working-tree paths that differ from HEAD (untracked + modified + deleted),
/// with ignores respected.
fn count_dirty(repo: &Repository) -> CoreResult<u32> {
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(gerr)?;
    Ok(statuses.len() as u32)
}

fn head_commit_info(repo: &Repository) -> Option<GitCommitInfo> {
    let commit = repo.head().ok()?.peel_to_commit().ok()?;
    let time = chrono::DateTime::from_timestamp(commit.time().seconds(), 0)?;
    Some(GitCommitInfo {
        id: commit.id().to_string(),
        message: commit
            .summary()
            .ok()
            .flatten()
            .unwrap_or_default()
            .to_string(),
        time: time.to_rfc3339(),
    })
}

/// Stage everything (respecting `.gitignore`) and commit as `name <email>`;
/// blank author fields fall back to the default identity — a cleared
/// settings field must degrade the author, not kill versioning. Returns
/// `Ok(None)` when there is nothing to commit, when the repository has an
/// operation in progress (user mid-merge/rebase in an adopted repo), or
/// when committing would fold in a manually curated index. Handles the
/// unborn HEAD of a fresh repo and never consults user-global git config —
/// the signature is always explicit.
pub fn commit_all(vault: &Path, name: &str, email: &str) -> CoreResult<Option<GitCommitInfo>> {
    let _gate = MUTATE_GATE.lock().unwrap_or_else(|p| p.into_inner());
    let defaults = crate::models::GitPrefs::default();
    let name = if name.trim().is_empty() {
        &defaults.author_name
    } else {
        name
    };
    let email = if email.trim().is_empty() {
        &defaults.author_email
    } else {
        email
    };
    let repo = open(vault).ok_or_else(|| {
        CoreError::BadRequest("vault is not a git repository — enable git sync first".to_string())
    })?;
    // Never commit into a user's in-flight operation (merge/rebase/
    // cherry-pick in an adopted repo): a single-parent auto-commit would
    // destroy the operation's ancestry. Resume once the repo is clean again.
    if repo.state() != git2::RepositoryState::Clean {
        log::info!(
            "git: repository busy ({:?}) — skipping commit",
            repo.state()
        );
        return Ok(None);
    }
    let dirty = count_dirty(&repo)?;
    if dirty == 0 {
        return Ok(None);
    }
    let mut index = repo.index().map_err(gerr)?;
    let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    // A manually curated index (user staged a PARTIAL change in an adopted
    // repo: index differs from HEAD *and* from the worktree) must not be
    // folded into an auto-commit — the staged selection would be lost.
    // index == worktree is fine to proceed: committing it changes nothing
    // the user didn't intend.
    let head_tree = match &parent {
        Some(c) => Some(c.tree().map_err(gerr)?),
        None => None,
    };
    let staged = repo
        .diff_tree_to_index(head_tree.as_ref(), Some(&index), None)
        .map_err(gerr)?
        .deltas()
        .len();
    if staged > 0 {
        let unstaged = repo
            .diff_index_to_workdir(Some(&index), None)
            .map_err(gerr)?
            .deltas()
            .len();
        if unstaged > 0 {
            log::warn!(
                "git: index holds manually staged changes — skipping commit to preserve them"
            );
            return Ok(None);
        }
    }
    // add_all stages new/modified paths (honoring ignores); update_all stages
    // modifications AND deletions of already-tracked paths.
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(gerr)?;
    index.update_all(["*"].iter(), None).map_err(gerr)?;
    index.write().map_err(gerr)?;
    let tree_id = index.write_tree().map_err(gerr)?;
    // Staging can still produce an unchanged tree (e.g. a file flipped dirty
    // and back); committing it would create an empty commit.
    if let Some(p) = &parent {
        if p.tree_id() == tree_id {
            return Ok(None);
        }
    }
    let tree = repo.find_tree(tree_id).map_err(gerr)?;
    let sig = Signature::now(name, email)
        .map_err(|e| CoreError::BadRequest(format!("invalid git author: {}", e.message())))?;
    let message = format!(
        "novalis: auto-commit ({dirty} change{})",
        if dirty == 1 { "" } else { "s" }
    );
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(gerr)?;
    Ok(head_commit_info(&repo))
}

/// The current HEAD commit id (full hex), or `None` if the repository is
/// unborn or not initialized. Used to capture a pre-session checkpoint that a
/// later [`reset_hard`] can revert to.
pub fn head_id(vault: &Path) -> Option<String> {
    open(vault)?
        .head()
        .ok()?
        .peel_to_commit()
        .ok()
        .map(|c| c.id().to_string())
}

/// Discard all working-tree and index changes and move HEAD to `commit_id`
/// (a full or abbreviated hex oid). This is the hard reset that makes an
/// agentic editing session revertable: commit the session's changes, then
/// reset back to the pre-session checkpoint to undo them wholesale — including
/// files the session *created*, which the forced checkout removes. Refuses
/// while the repository has an operation in progress (merge/rebase in an
/// adopted repo) so it can never trash a user's in-flight work.
pub fn reset_hard(vault: &Path, commit_id: &str) -> CoreResult<()> {
    let _gate = MUTATE_GATE.lock().unwrap_or_else(|p| p.into_inner());
    let repo = open(vault).ok_or_else(|| {
        CoreError::BadRequest("vault is not a git repository — enable git sync first".to_string())
    })?;
    if repo.state() != git2::RepositoryState::Clean {
        return Err(CoreError::BadRequest(format!(
            "repository is busy ({:?}) — finish that operation first",
            repo.state()
        )));
    }
    let oid = Oid::from_str(commit_id)
        .map_err(|_| CoreError::BadRequest(format!("not a valid commit id: {commit_id}")))?;
    let obj = repo.find_object(oid, None).map_err(gerr)?;
    repo.reset(&obj, git2::ResetType::Hard, None)
        .map_err(gerr)?;
    Ok(())
}

/// Set, replace, or (with `None`/blank) remove the vault's `origin` remote.
/// The repo's git config is the single source of truth for the URL. Scheme
/// validation (https-only — this build carries no ssh transport) lives at
/// the command boundary so tests can use local-path remotes.
pub fn set_remote(vault: &Path, url: Option<&str>) -> CoreResult<()> {
    let _gate = MUTATE_GATE.lock().unwrap_or_else(|p| p.into_inner());
    let repo = open(vault).ok_or_else(|| {
        CoreError::BadRequest("vault is not a git repository — enable git sync first".to_string())
    })?;
    let existing = repo.find_remote("origin").is_ok();
    match url.map(str::trim).filter(|u| !u.is_empty()) {
        Some(u) if existing => repo.remote_set_url("origin", u).map_err(gerr),
        Some(u) => repo.remote("origin", u).map(|_| ()).map_err(gerr),
        None if existing => repo.remote_delete("origin").map_err(gerr),
        None => Ok(()),
    }
}

/// Attempt-bounded credential callbacks. libgit2 re-invokes the credentials
/// callback on EVERY 401 — unbounded, a revoked token loops forever
/// (verified live in the auth spike). The username is a dummy: GitHub and
/// GitLab accept any non-empty username with a PAT/token as the password.
fn auth_callbacks(token: Option<String>) -> RemoteCallbacks<'static> {
    let mut cb = RemoteCallbacks::new();
    let attempts = AtomicU32::new(0);
    cb.credentials(move |_url, _username, _allowed| {
        if attempts.fetch_add(1, Ordering::SeqCst) >= 3 {
            return Err(git2::Error::from_str(
                "authentication rejected after 3 attempts — check the access token",
            ));
        }
        match &token {
            Some(t) => Cred::userpass_plaintext("x-access-token", t),
            None => Err(git2::Error::from_str(
                "no access token configured for this vault",
            )),
        }
    });
    cb
}

/// One sync cycle against `origin`: fetch, then exactly one action — fast-
/// forward, push, or (P2b) an automatic 3-way merge when both sides have new
/// commits. Local pending changes are committed first. A merge with
/// conflicting edits stops the cycle with [`GitSyncKind::Conflicted`]
/// without touching the working tree; force-pushing is never an option. An
/// unborn local branch adopts a populated remote (first sync of a fresh
/// vault) — there, `.novalis/` prefs are the only local files the adoption
/// may replace (they are synced-by-design: the remote copy beats defaults
/// written moments ago by "enable git sync").
pub fn sync(
    vault: &Path,
    name: &str,
    email: &str,
    token: Option<&str>,
) -> CoreResult<GitSyncOutcome> {
    let _sync = SYNC_GATE.lock().unwrap_or_else(|p| p.into_inner());
    ensure_network_timeouts();
    ensure_repo(vault)?;
    let repo = open(vault)
        .ok_or_else(|| CoreError::Internal("git: repository vanished after init".to_string()))?;
    if repo.find_remote("origin").is_err() {
        return Ok(outcome(GitSyncKind::NoRemote, 0, 0));
    }
    let branch = current_branch(&repo);
    {
        let mut remote = repo.find_remote("origin").map_err(gerr)?;
        let mut fo = FetchOptions::new();
        fo.remote_callbacks(auth_callbacks(token.map(str::to_string)));
        remote
            .fetch(&[branch.as_str()], Some(&mut fo), None)
            .map_err(gerr)?;
    }
    let local_ref = format!("refs/heads/{branch}");
    let remote_ref = format!("refs/remotes/origin/{branch}");
    let local = repo
        .find_reference(&local_ref)
        .ok()
        .and_then(|r| r.target());
    let remote_tip = repo
        .find_reference(&remote_ref)
        .ok()
        .and_then(|r| r.target());

    // First sync of a fresh vault against a populated remote: adopt the
    // remote history BEFORE committing local state — otherwise the
    // just-written .novalis/config.json becomes an unrelated root commit
    // and every adoption ends permanently diverged.
    if local.is_none() {
        if let Some(tip) = remote_tip {
            let behind = count_commits(&repo, tip)?;
            {
                let _gate = MUTATE_GATE.lock().unwrap_or_else(|p| p.into_inner());
                adopt_remote(&repo, &local_ref, tip)?;
            }
            // Local extras (e.g. device-specific pref deltas) become a
            // normal follow-up commit; the next cycle pushes it.
            commit_all(vault, name, email)?;
            return Ok(outcome(GitSyncKind::Pulled, 0, behind));
        }
    }

    commit_all(vault, name, email)?;
    let local = repo
        .find_reference(&local_ref)
        .ok()
        .and_then(|r| r.target());
    let Some(local) = local else {
        // Still unborn: the vault is truly empty and so is the remote.
        return Ok(outcome(GitSyncKind::UpToDate, 0, 0));
    };
    let Some(remote_tip) = remote_tip else {
        let ahead = count_commits(&repo, local)?;
        push_branch(&repo, &branch, token)?;
        return Ok(outcome(GitSyncKind::Pushed, ahead, 0));
    };
    if local == remote_tip {
        return Ok(outcome(GitSyncKind::UpToDate, 0, 0));
    }
    let (ahead, behind) = repo
        .graph_ahead_behind(local, remote_tip)
        .map(|(a, b)| (a as u32, b as u32))
        .map_err(gerr)?;
    if behind == 0 {
        push_branch(&repo, &branch, token)?;
        Ok(outcome(GitSyncKind::Pushed, ahead, 0))
    } else if ahead == 0 {
        let _gate = MUTATE_GATE.lock().unwrap_or_else(|p| p.into_inner());
        fast_forward(&repo, &local_ref, remote_tip)?;
        Ok(outcome(GitSyncKind::Pulled, 0, behind))
    } else if repo.state() != git2::RepositoryState::Clean {
        // A busy repository (user mid-merge/rebase in an adopted repo) is
        // never merged over — and `commit_all` above skipped for the same
        // reason, so the worktree may be dirty. Surface the plain
        // divergence like P2a did; the cycle resumes once the user's
        // operation finishes.
        Ok(outcome(GitSyncKind::Diverged, ahead, behind))
    } else {
        let kind = merge_diverged(&repo, &branch, local, remote_tip, name, email, token)?;
        Ok(outcome(kind, ahead, behind))
    }
}

/// P2b: reconcile truly diverged histories with an automatic 3-way merge
/// (spike-proven recipe). Detection runs entirely in memory via
/// `merge_commits` — no workdir, index, or `.git` state (MERGE_HEAD) is
/// touched. Conflicts return [`GitSyncKind::Conflicted`] with the affected
/// paths (each side of a conflict entry can be absent — delete-vs-edit). A
/// clean merge is materialized: 2-parent commit, safe checkout + branch
/// move under [`MUTATE_GATE`] (checkout FIRST, same rationale as
/// [`fast_forward`] — a dirty tree errors loudly and leaves ref and
/// worktree untouched), then a normal push under [`SYNC_GATE`] only. The
/// caller holds [`SYNC_GATE`]; the lock order SYNC_GATE → MUTATE_GATE is
/// preserved, and the gate is released before the network push.
fn merge_diverged(
    repo: &Repository,
    branch: &str,
    local: Oid,
    remote_tip: Oid,
    name: &str,
    email: &str,
    token: Option<&str>,
) -> CoreResult<GitSyncKind> {
    let ours = repo.find_commit(local).map_err(gerr)?;
    let theirs = repo.find_commit(remote_tip).map_err(gerr)?;
    let mut merged = repo.merge_commits(&ours, &theirs, None).map_err(gerr)?;
    if merged.has_conflicts() {
        let mut paths = Vec::new();
        for entry in merged.conflicts().map_err(gerr)? {
            let entry = entry.map_err(gerr)?;
            // All three sides are Option — delete-vs-edit leaves one side
            // absent. Take the path from whichever side exists.
            if let Some(side) = entry
                .our
                .as_ref()
                .or(entry.their.as_ref())
                .or(entry.ancestor.as_ref())
            {
                paths.push(String::from_utf8_lossy(&side.path).into_owned());
            }
        }
        paths.sort();
        paths.dedup();
        return Ok(GitSyncKind::Conflicted { paths });
    }
    // Same author fallback as commit_all: a cleared settings field must
    // degrade the identity, not kill the sync cycle.
    let defaults = crate::models::GitPrefs::default();
    let name = if name.trim().is_empty() {
        &defaults.author_name
    } else {
        name
    };
    let email = if email.trim().is_empty() {
        &defaults.author_email
    } else {
        email
    };
    let sig = Signature::now(name, email)
        .map_err(|e| CoreError::BadRequest(format!("invalid git author: {}", e.message())))?;
    {
        let _gate = MUTATE_GATE.lock().unwrap_or_else(|p| p.into_inner());
        let tree_id = merged.write_tree_to(repo).map_err(gerr)?;
        let tree = repo.find_tree(tree_id).map_err(gerr)?;
        let message = format!("novalis: merge origin/{branch}");
        // No ref update yet: the commit object is created dangling so a
        // failed checkout leaves the branch untouched (the object is
        // harmless and gc-able).
        let merge_oid = repo
            .commit(None, &sig, &sig, &message, &tree, &[&ours, &theirs])
            .map_err(gerr)?;
        let mut co = CheckoutBuilder::new();
        co.safe();
        repo.checkout_tree(tree.as_object(), Some(&mut co))
            .map_err(gerr)?;
        repo.find_reference(&format!("refs/heads/{branch}"))
            .map_err(gerr)?
            .set_target(merge_oid, "novalis: merge")
            .map_err(gerr)?;
        // Defensive per the spike recipe — the in-memory merge writes no
        // .git state, so this is a no-op unless something left one behind.
        repo.cleanup_state().map_err(gerr)?;
    }
    push_branch(repo, branch, token)?;
    Ok(GitSyncKind::Merged)
}

fn outcome(kind: GitSyncKind, ahead: u32, behind: u32) -> GitSyncOutcome {
    GitSyncOutcome {
        kind,
        ahead,
        behind,
    }
}

/// Total commit count reachable from `tip` (used for "pushed/pulled N").
fn count_commits(repo: &Repository, tip: Oid) -> CoreResult<u32> {
    let mut walk = repo.revwalk().map_err(gerr)?;
    walk.push(tip).map_err(gerr)?;
    Ok(walk.count() as u32)
}

/// Push the branch to `origin`. A server-side rejection (e.g. another
/// device pushed between our fetch and push) surfaces as an error — the
/// next cycle fetches and resolves; force-pushing is never an option.
fn push_branch(repo: &Repository, branch: &str, token: Option<&str>) -> CoreResult<()> {
    let mut remote = repo.find_remote("origin").map_err(gerr)?;
    let rejected: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let sink = rejected.clone();
    let mut cb = auth_callbacks(token.map(str::to_string));
    cb.push_update_reference(move |name, status| {
        if let Some(msg) = status {
            if let Ok(mut slot) = sink.lock() {
                *slot = Some(format!("{name}: {msg}"));
            }
        }
        Ok(())
    });
    let mut po = PushOptions::new();
    po.remote_callbacks(cb);
    remote
        .push(
            &[format!("refs/heads/{branch}:refs/heads/{branch}")],
            Some(&mut po),
        )
        .map_err(gerr)?;
    let rejection = rejected.lock().ok().and_then(|mut s| s.take());
    if let Some(r) = rejection {
        return Err(CoreError::Internal(format!("git: push rejected: {r}")));
    }
    Ok(())
}

/// Fast-forward the local branch to `target`. The safe (non-force) checkout
/// runs FIRST: with the clean tree we just committed it succeeds; a dirty
/// tree (ms-scale race with a save) errors loudly and leaves the branch ref
/// untouched for the next cycle. Never discards local content.
fn fast_forward(repo: &Repository, local_ref: &str, target: Oid) -> CoreResult<()> {
    let commit = repo.find_commit(target).map_err(gerr)?;
    let mut co = CheckoutBuilder::new();
    co.safe();
    repo.checkout_tree(commit.as_object(), Some(&mut co))
        .map_err(gerr)?;
    repo.find_reference(local_ref)
        .map_err(gerr)?
        .set_target(target, "novalis: fast-forward")
        .map_err(gerr)?;
    Ok(())
}

/// Point an unborn branch at a populated remote and check the tree out.
/// Conflicting untracked files abort the adoption — EXCEPT `.novalis/`
/// prefs and `.gitignore`, where the remote copy wins (both are
/// Novalis-maintained and were (re)written moments ago by the enable
/// toggle; ignore lines missing from the remote copy are re-appended by
/// the next `ensure_repo`). Note bodies are never replaced.
fn adopt_remote(repo: &Repository, local_ref: &str, tip: Oid) -> CoreResult<()> {
    let commit = repo.find_commit(tip).map_err(gerr)?;
    let conflicts: RefCell<Vec<PathBuf>> = RefCell::new(Vec::new());
    let first = {
        let mut co = CheckoutBuilder::new();
        co.safe();
        co.notify_on(git2::CheckoutNotificationType::CONFLICT);
        co.notify(|_kind, path, _, _, _| {
            if let Some(p) = path {
                conflicts.borrow_mut().push(p.to_path_buf());
            }
            true
        });
        repo.checkout_tree(commit.as_object(), Some(&mut co))
    };
    if let Err(e) = first {
        let paths = conflicts.into_inner();
        let replaceable = |p: &PathBuf| p.starts_with(".novalis") || p == Path::new(".gitignore");
        let only_novalis = !paths.is_empty() && paths.iter().all(replaceable);
        if !only_novalis {
            if paths.is_empty() {
                return Err(gerr(e));
            }
            return Err(CoreError::BadRequest(format!(
                "adopting the remote would overwrite {} local file(s) (e.g. {}) — start from an empty folder",
                paths.len(),
                paths[0].display(),
            )));
        }
        let workdir = repo
            .workdir()
            .ok_or_else(|| CoreError::Internal("git: bare repository has no worktree".into()))?;
        for p in &paths {
            let _ = std::fs::remove_file(workdir.join(p));
        }
        let mut co = CheckoutBuilder::new();
        co.safe();
        repo.checkout_tree(commit.as_object(), Some(&mut co))
            .map_err(gerr)?;
    }
    repo.reference(local_ref, tip, true, "novalis: adopt remote")
        .map_err(gerr)?;
    repo.set_head(local_ref).map_err(gerr)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A vault fixture with notes plus the app-internal dirs that must stay
    /// out of history.
    fn vault() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "# A\n").unwrap();
        std::fs::create_dir_all(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/b.md"), "# B\n").unwrap();
        std::fs::create_dir_all(dir.path().join(".novalis/trash")).unwrap();
        std::fs::create_dir_all(dir.path().join(".novalis/versions")).unwrap();
        std::fs::write(dir.path().join(".novalis/trash/t.md"), "trashed\n").unwrap();
        std::fs::write(dir.path().join(".novalis/versions/v.md"), "old\n").unwrap();
        std::fs::write(dir.path().join(".novalis/config.json"), "{}\n").unwrap();
        dir
    }

    fn head_tree_paths(vault: &Path) -> Vec<String> {
        let repo = Repository::open(vault).unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        let mut paths = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
            if entry.kind() == Some(git2::ObjectType::Blob) {
                paths.push(format!("{root}{}", entry.name().unwrap_or_default()));
            }
            git2::TreeWalkResult::Ok
        })
        .unwrap();
        paths.sort();
        paths
    }

    #[test]
    fn ensure_repo_inits_main_head_and_gitignore() {
        let dir = vault();
        ensure_repo(dir.path()).unwrap();
        let ignore = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        for line in IGNORE_LINES {
            assert!(ignore.lines().any(|l| l == line), "missing {line}");
        }
        // Unborn HEAD must already point at main (the bare-master footgun).
        let repo = Repository::open(dir.path()).unwrap();
        let head = repo.find_reference("HEAD").unwrap();
        assert_eq!(head.symbolic_target().unwrap(), Some("refs/heads/main"));
    }

    #[test]
    fn ensure_repo_preserves_user_gitignore_and_is_idempotent() {
        let dir = vault();
        std::fs::write(dir.path().join(".gitignore"), "drafts/\n").unwrap();
        ensure_repo(dir.path()).unwrap();
        ensure_repo(dir.path()).unwrap();
        let ignore = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(ignore.lines().any(|l| l == "drafts/"));
        for line in IGNORE_LINES {
            assert_eq!(
                ignore.lines().filter(|l| *l == line).count(),
                1,
                "{line} duplicated"
            );
        }
    }

    #[test]
    fn first_commit_works_on_unborn_head_without_global_config() {
        let dir = vault();
        ensure_repo(dir.path()).unwrap();
        let info = commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .expect("first commit");
        assert!(info.message.contains("auto-commit"));
        let status = repo_status(dir.path()).unwrap();
        assert!(status.initialized);
        assert_eq!(status.dirty, 0);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.last_commit.unwrap().id, info.id);
    }

    #[test]
    fn trash_and_versions_stay_out_of_history_but_config_is_tracked() {
        let dir = vault();
        ensure_repo(dir.path()).unwrap();
        commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .unwrap();
        let paths = head_tree_paths(dir.path());
        assert!(paths.contains(&"a.md".to_string()));
        assert!(paths.contains(&"sub/b.md".to_string()));
        assert!(paths.contains(&".novalis/config.json".to_string()));
        assert!(paths.contains(&".gitignore".to_string()));
        assert!(!paths.iter().any(|p| p.starts_with(".novalis/trash")));
        assert!(!paths.iter().any(|p| p.starts_with(".novalis/versions")));
    }

    #[test]
    fn clean_tree_commits_nothing() {
        let dir = vault();
        ensure_repo(dir.path()).unwrap();
        commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .unwrap();
        assert!(commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .is_none());
        // Touching only ignored paths must also commit nothing.
        std::fs::write(dir.path().join(".novalis/trash/more.md"), "x\n").unwrap();
        assert!(commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .is_none());
    }

    #[test]
    fn modifications_and_deletions_are_committed() {
        let dir = vault();
        ensure_repo(dir.path()).unwrap();
        commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .unwrap();
        std::fs::write(dir.path().join("a.md"), "# A changed\n").unwrap();
        std::fs::remove_file(dir.path().join("sub/b.md")).unwrap();
        let info = commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .expect("second commit");
        assert!(info.message.contains("2 changes"));
        let paths = head_tree_paths(dir.path());
        assert!(!paths.contains(&"sub/b.md".to_string()), "deletion staged");
        // History now has two commits.
        let repo = Repository::open(dir.path()).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 1);
    }

    #[test]
    fn blank_author_falls_back_to_defaults_instead_of_failing() {
        // A cleared settings field must degrade the author, not permanently
        // kill the auto-committer (which only logs failures).
        let dir = vault();
        ensure_repo(dir.path()).unwrap();
        commit_all(dir.path(), " ", "")
            .unwrap()
            .expect("commit with fallback author");
        let repo = Repository::open(dir.path()).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let author = head.author();
        assert_eq!(author.name().unwrap(), "Novalis");
        assert_eq!(author.email().unwrap(), "novalis@localhost");
    }

    #[test]
    fn stale_locks_are_cleared_but_fresh_locks_respected() {
        let dir = vault();
        ensure_repo(dir.path()).unwrap();
        let lock = dir.path().join(".git/index.lock");
        // A fresh lock (live contention, e.g. the user's git CLI) survives
        // the real threshold…
        std::fs::write(&lock, "").unwrap();
        remove_stale_locks(dir.path(), STALE_LOCK_AGE);
        assert!(lock.exists(), "fresh lock must be respected");
        // …but a lock older than the threshold is cleared (age forced to
        // zero here — mtimes can't be backdated without extra deps).
        remove_stale_locks(dir.path(), Duration::ZERO);
        assert!(!lock.exists(), "stale lock must be removed");
        commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .expect("commit succeeds after stale lock cleanup");
    }

    #[test]
    fn non_utf8_user_gitignore_is_appended_to_not_destroyed() {
        let dir = vault();
        // Latin-1 "# Entwürfe" — read_to_string would fail on this.
        let user_bytes: &[u8] = b"# Entw\xfcrfe\nprivate/\n";
        std::fs::write(dir.path().join(".gitignore"), user_bytes).unwrap();
        ensure_repo(dir.path()).unwrap();
        let bytes = std::fs::read(dir.path().join(".gitignore")).unwrap();
        assert!(bytes.starts_with(user_bytes), "user content preserved");
        for line in IGNORE_LINES {
            assert!(
                bytes
                    .split(|b| *b == b'\n')
                    .any(|l| l.trim_ascii() == line.as_bytes()),
                "missing {line}"
            );
        }
    }

    #[test]
    fn in_flight_merge_state_skips_commit() {
        let dir = vault();
        ensure_repo(dir.path()).unwrap();
        let baseline = commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .unwrap();
        // Simulate a user mid-merge in an adopted repo: MERGE_HEAD present.
        std::fs::write(
            dir.path().join(".git/MERGE_HEAD"),
            format!("{}\n", baseline.id),
        )
        .unwrap();
        std::fs::write(dir.path().join("a.md"), "# A edited\n").unwrap();
        assert!(
            commit_all(dir.path(), "Novalis", "novalis@localhost")
                .unwrap()
                .is_none(),
            "must not commit into an in-flight merge"
        );
        // Operation finished → commits resume.
        std::fs::remove_file(dir.path().join(".git/MERGE_HEAD")).unwrap();
        assert!(commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .is_some());
    }

    #[test]
    fn manually_staged_partial_change_is_preserved_not_clobbered() {
        let dir = vault();
        ensure_repo(dir.path()).unwrap();
        commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .unwrap();
        // User stages v2 of a note (git add), then keeps editing to v3.
        std::fs::write(dir.path().join("a.md"), "# A v2\n").unwrap();
        {
            let repo = Repository::open(dir.path()).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.md")).unwrap();
            index.write().unwrap();
        }
        std::fs::write(dir.path().join("a.md"), "# A v3\n").unwrap();
        assert!(
            commit_all(dir.path(), "Novalis", "novalis@localhost")
                .unwrap()
                .is_none(),
            "curated index must not be folded into an auto-commit"
        );
        // The staged v2 blob is still in the index, untouched.
        let repo = Repository::open(dir.path()).unwrap();
        let index = repo.index().unwrap();
        let entry = index.get_path(Path::new("a.md"), 0).unwrap();
        let blob = repo.find_blob(entry.id).unwrap();
        assert_eq!(blob.content(), b"# A v2\n");
    }

    #[test]
    fn reset_hard_reverts_edits_and_removes_session_files() {
        let dir = vault();
        ensure_repo(dir.path()).unwrap();
        commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .unwrap();
        let base = head_id(dir.path()).expect("base checkpoint");
        // Simulate an agentic session: edit a tracked note and create a new one.
        std::fs::write(dir.path().join("a.md"), "# A rewritten by the agent\n").unwrap();
        std::fs::write(dir.path().join("new-by-agent.md"), "agent output\n").unwrap();
        commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .expect("session commit");
        assert_ne!(head_id(dir.path()).unwrap(), base, "session advanced HEAD");

        // Undo the whole session by resetting to the pre-session checkpoint.
        reset_hard(dir.path(), &base).unwrap();
        assert_eq!(
            head_id(dir.path()).unwrap(),
            base,
            "HEAD back at checkpoint"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("a.md")).unwrap(),
            "# A\n",
            "edit reverted"
        );
        assert!(
            !dir.path().join("new-by-agent.md").exists(),
            "session-created file removed"
        );
    }

    #[test]
    fn head_id_is_none_on_a_plain_folder() {
        let dir = vault();
        assert!(head_id(dir.path()).is_none());
    }

    #[test]
    fn reset_hard_rejects_an_invalid_commit_id() {
        let dir = vault();
        ensure_repo(dir.path()).unwrap();
        commit_all(dir.path(), "Novalis", "novalis@localhost")
            .unwrap()
            .unwrap();
        let err = reset_hard(dir.path(), "not-a-real-oid").unwrap_err();
        assert!(matches!(err, CoreError::BadRequest(_)));
    }

    #[test]
    fn status_on_plain_folder_reports_uninitialized() {
        let dir = vault();
        let status = repo_status(dir.path()).unwrap();
        assert!(!status.initialized);
        assert_eq!(status.dirty, 0);
        assert!(status.last_commit.is_none());
        assert!(status.remote_url.is_none());
    }

    // ── Sync (P2a) — local-path remotes, no network involved ────────────────

    fn bare_remote() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let mut opts = RepositoryInitOptions::new();
        opts.bare(true);
        opts.initial_head("main");
        Repository::init_opts(dir.path(), &opts).unwrap();
        dir
    }

    fn remote_path(dir: &tempfile::TempDir) -> String {
        dir.path().to_string_lossy().to_string()
    }

    #[test]
    fn sync_without_remote_reports_no_remote() {
        let dir = vault();
        ensure_repo(dir.path()).unwrap();
        let out = sync(dir.path(), "Novalis", "novalis@localhost", None).unwrap();
        assert_eq!(out.kind, GitSyncKind::NoRemote);
    }

    #[test]
    fn first_sync_pushes_to_empty_remote_then_up_to_date() {
        let dir = vault();
        let bare = bare_remote();
        ensure_repo(dir.path()).unwrap();
        set_remote(dir.path(), Some(&remote_path(&bare))).unwrap();
        let out = sync(dir.path(), "Novalis", "novalis@localhost", None).unwrap();
        assert_eq!(out.kind, GitSyncKind::Pushed);
        assert_eq!(out.ahead, 1);
        let bare_tip = Repository::open(bare.path())
            .unwrap()
            .find_reference("refs/heads/main")
            .unwrap()
            .target()
            .unwrap();
        let local_tip = Repository::open(dir.path())
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap();
        assert_eq!(bare_tip, local_tip);
        let out = sync(dir.path(), "Novalis", "novalis@localhost", None).unwrap();
        assert_eq!(out.kind, GitSyncKind::UpToDate);
        let status = repo_status(dir.path()).unwrap();
        assert_eq!(
            status.remote_url.as_deref(),
            Some(remote_path(&bare).as_str())
        );
        assert_eq!((status.ahead, status.behind), (0, 0));
    }

    #[test]
    fn fresh_vault_adopts_remote_then_pulls_fast_forward() {
        // Device A pushes its vault…
        let a = vault();
        let bare = bare_remote();
        ensure_repo(a.path()).unwrap();
        set_remote(a.path(), Some(&remote_path(&bare))).unwrap();
        sync(a.path(), "A", "a@x", None).unwrap();
        // …device B starts from an empty folder holding only the fresh
        // prefs that "enable git sync" just wrote.
        let b = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(b.path().join(".novalis")).unwrap();
        std::fs::write(b.path().join(".novalis/config.json"), "{\"fresh\":true}\n").unwrap();
        ensure_repo(b.path()).unwrap();
        set_remote(b.path(), Some(&remote_path(&bare))).unwrap();
        let out = sync(b.path(), "B", "b@x", None).unwrap();
        assert_eq!(out.kind, GitSyncKind::Pulled);
        assert!(b.path().join("a.md").exists(), "remote notes arrived");
        // Remote prefs win over the just-written local defaults.
        assert_eq!(
            std::fs::read_to_string(b.path().join(".novalis/config.json")).unwrap(),
            "{}\n"
        );
        // A edits and pushes; B fast-forwards and sees the new content.
        std::fs::write(a.path().join("a.md"), "# A changed\n").unwrap();
        assert_eq!(
            sync(a.path(), "A", "a@x", None).unwrap().kind,
            GitSyncKind::Pushed
        );
        let out = sync(b.path(), "B", "b@x", None).unwrap();
        assert_eq!(out.kind, GitSyncKind::Pulled);
        assert_eq!(out.behind, 1);
        assert_eq!(
            std::fs::read_to_string(b.path().join("a.md")).unwrap(),
            "# A changed\n"
        );
    }

    #[test]
    fn adoption_refuses_to_overwrite_user_notes() {
        let a = vault();
        let bare = bare_remote();
        ensure_repo(a.path()).unwrap();
        set_remote(a.path(), Some(&remote_path(&bare))).unwrap();
        sync(a.path(), "A", "a@x", None).unwrap();
        // B's folder already contains a DIFFERENT a.md — adopting would
        // overwrite a note body, which is disqualifying.
        let b = tempfile::tempdir().unwrap();
        std::fs::write(b.path().join("a.md"), "# different local note\n").unwrap();
        ensure_repo(b.path()).unwrap();
        set_remote(b.path(), Some(&remote_path(&bare))).unwrap();
        let err = sync(b.path(), "B", "b@x", None).unwrap_err();
        assert!(matches!(err, CoreError::BadRequest(_)));
        assert_eq!(
            std::fs::read_to_string(b.path().join("a.md")).unwrap(),
            "# different local note\n",
            "local note must be untouched"
        );
    }

    #[test]
    fn conflicting_histories_stop_without_force() {
        let a = vault();
        let bare = bare_remote();
        ensure_repo(a.path()).unwrap();
        set_remote(a.path(), Some(&remote_path(&bare))).unwrap();
        sync(a.path(), "A", "a@x", None).unwrap();
        let b = tempfile::tempdir().unwrap();
        ensure_repo(b.path()).unwrap();
        set_remote(b.path(), Some(&remote_path(&bare))).unwrap();
        sync(b.path(), "B", "b@x", None).unwrap();
        // Both sides edit the same note — P2b detects the conflict in
        // memory and stops the cycle.
        std::fs::write(a.path().join("a.md"), "# from A\n").unwrap();
        assert_eq!(
            sync(a.path(), "A", "a@x", None).unwrap().kind,
            GitSyncKind::Pushed
        );
        std::fs::write(b.path().join("a.md"), "# from B\n").unwrap();
        let out = sync(b.path(), "B", "b@x", None).unwrap();
        assert_eq!(
            out.kind,
            GitSyncKind::Conflicted {
                paths: vec!["a.md".into()],
            }
        );
        assert_eq!((out.ahead, out.behind), (1, 1));
        // Nothing was forced anywhere: the remote still has A's tip, B's
        // worktree keeps B's edit, and the local commit preserves it.
        let bare_repo = Repository::open(bare.path()).unwrap();
        let remote_tip = bare_repo
            .find_reference("refs/heads/main")
            .unwrap()
            .target()
            .unwrap();
        let a_tip = Repository::open(a.path())
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap();
        assert_eq!(remote_tip, a_tip);
        assert_eq!(
            std::fs::read_to_string(b.path().join("a.md")).unwrap(),
            "# from B\n"
        );
        let status = repo_status(b.path()).unwrap();
        assert_eq!((status.ahead, status.behind), (1, 1));
    }

    // ── Auto-merge (P2b) ─────────────────────────────────────────────────────

    /// Device A pushes the fixture vault; device B adopts it from an empty
    /// folder. Both end on the same tip.
    fn two_synced_clones() -> (tempfile::TempDir, tempfile::TempDir, tempfile::TempDir) {
        let a = vault();
        let bare = bare_remote();
        ensure_repo(a.path()).unwrap();
        set_remote(a.path(), Some(&remote_path(&bare))).unwrap();
        assert_eq!(
            sync(a.path(), "A", "a@x", None).unwrap().kind,
            GitSyncKind::Pushed
        );
        let b = tempfile::tempdir().unwrap();
        ensure_repo(b.path()).unwrap();
        set_remote(b.path(), Some(&remote_path(&bare))).unwrap();
        assert_eq!(
            sync(b.path(), "B", "b@x", None).unwrap().kind,
            GitSyncKind::Pulled
        );
        (a, bare, b)
    }

    /// Every file under `root` (relative path → bytes), `.git` excluded.
    fn worktree_snapshot(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
        fn walk(root: &Path, dir: &Path, out: &mut std::collections::BTreeMap<String, Vec<u8>>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.file_name().is_some_and(|n| n == ".git") {
                    continue;
                }
                if path.is_dir() {
                    walk(root, &path, out);
                } else {
                    let rel = path
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/");
                    out.insert(rel, std::fs::read(&path).unwrap());
                }
            }
        }
        let mut out = std::collections::BTreeMap::new();
        walk(root, root, &mut out);
        out
    }

    fn head_tree_id(vault: &Path) -> Oid {
        let repo = Repository::open(vault).unwrap();
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        tree.id()
    }

    #[test]
    fn non_overlapping_edits_merge_and_both_clones_converge() {
        let (a, _bare, b) = two_synced_clones();
        // Divergence in DIFFERENT files: A edits a.md, B edits sub/b.md.
        std::fs::write(a.path().join("a.md"), "# from A\n").unwrap();
        assert_eq!(
            sync(a.path(), "A", "a@x", None).unwrap().kind,
            GitSyncKind::Pushed
        );
        std::fs::write(b.path().join("sub/b.md"), "# from B\n").unwrap();
        let out = sync(b.path(), "B", "b@x", None).unwrap();
        assert_eq!(out.kind, GitSyncKind::Merged);
        assert_eq!((out.ahead, out.behind), (1, 1));
        // B's worktree holds both edits.
        assert_eq!(
            std::fs::read_to_string(b.path().join("a.md")).unwrap(),
            "# from A\n"
        );
        assert_eq!(
            std::fs::read_to_string(b.path().join("sub/b.md")).unwrap(),
            "# from B\n"
        );
        // History has exactly one 2-parent commit, authored as the
        // configured identity of the merging device.
        let repo = Repository::open(b.path()).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);
        let author = head.author();
        assert_eq!(author.name().unwrap(), "B");
        assert_eq!(author.email().unwrap(), "b@x");
        let mut walk = repo.revwalk().unwrap();
        walk.push(head.id()).unwrap();
        let merges = walk
            .flatten()
            .filter(|oid| repo.find_commit(*oid).unwrap().parent_count() > 1)
            .count();
        assert_eq!(merges, 1, "exactly one merge commit in history");
        // A pulls the merge; both clones converge byte-identically.
        assert_eq!(
            sync(a.path(), "A", "a@x", None).unwrap().kind,
            GitSyncKind::Pulled
        );
        assert_eq!(head_tree_id(a.path()), head_tree_id(b.path()));
        assert_eq!(
            std::fs::read_to_string(a.path().join("sub/b.md")).unwrap(),
            "# from B\n"
        );
    }

    #[test]
    fn merged_outcome_pushes_and_next_sync_is_up_to_date() {
        let (a, bare, b) = two_synced_clones();
        std::fs::write(a.path().join("a.md"), "# from A\n").unwrap();
        sync(a.path(), "A", "a@x", None).unwrap();
        std::fs::write(b.path().join("sub/b.md"), "# from B\n").unwrap();
        assert_eq!(
            sync(b.path(), "B", "b@x", None).unwrap().kind,
            GitSyncKind::Merged
        );
        // The bare remote's tip IS the merge commit.
        let bare_repo = Repository::open(bare.path()).unwrap();
        let remote_tip = bare_repo
            .find_reference("refs/heads/main")
            .unwrap()
            .target()
            .unwrap();
        let b_head = Repository::open(b.path())
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap();
        assert_eq!(remote_tip, b_head);
        assert_eq!(bare_repo.find_commit(remote_tip).unwrap().parent_count(), 2);
        // Nothing left to transfer.
        let out = sync(b.path(), "B", "b@x", None).unwrap();
        assert_eq!(out.kind, GitSyncKind::UpToDate);
    }

    #[test]
    fn overlapping_edits_conflict_without_touching_worktree_or_state() {
        let (a, bare, b) = two_synced_clones();
        // Both sides edit the SAME two files.
        std::fs::write(a.path().join("sub/b.md"), "# b from A\n").unwrap();
        std::fs::write(a.path().join("a.md"), "# a from A\n").unwrap();
        sync(a.path(), "A", "a@x", None).unwrap();
        std::fs::write(b.path().join("sub/b.md"), "# b from B\n").unwrap();
        std::fs::write(b.path().join("a.md"), "# a from B\n").unwrap();
        let before = worktree_snapshot(b.path());
        let out = sync(b.path(), "B", "b@x", None).unwrap();
        assert_eq!(
            out.kind,
            GitSyncKind::Conflicted {
                paths: vec!["a.md".into(), "sub/b.md".into()],
            },
            "paths are relative and sorted"
        );
        assert_eq!((out.ahead, out.behind), (1, 1));
        // Detection was in-memory: the working tree is byte-identical and
        // no merge state was persisted.
        assert_eq!(worktree_snapshot(b.path()), before);
        let repo = Repository::open(b.path()).unwrap();
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
        assert!(!b.path().join(".git/MERGE_HEAD").exists());
        // The remote was never force-pushed: its tip is still A's.
        let remote_tip = Repository::open(bare.path())
            .unwrap()
            .find_reference("refs/heads/main")
            .unwrap()
            .target()
            .unwrap();
        let a_tip = Repository::open(a.path())
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap();
        assert_eq!(remote_tip, a_tip);
        // A second cycle reports the same conflict — nothing is stuck.
        let again = sync(b.path(), "B", "b@x", None).unwrap();
        assert_eq!(again.kind, out.kind);
        assert_eq!(worktree_snapshot(b.path()), before);
    }

    #[test]
    fn delete_vs_edit_reports_conflict_without_panic() {
        let (a, _bare, b) = two_synced_clones();
        // A deletes the note; B edits it.
        std::fs::remove_file(a.path().join("a.md")).unwrap();
        sync(a.path(), "A", "a@x", None).unwrap();
        std::fs::write(b.path().join("a.md"), "# edited on B\n").unwrap();
        let out = sync(b.path(), "B", "b@x", None).unwrap();
        assert_eq!(
            out.kind,
            GitSyncKind::Conflicted {
                paths: vec!["a.md".into()],
            }
        );
        // B's edit is untouched on disk.
        assert_eq!(
            std::fs::read_to_string(b.path().join("a.md")).unwrap(),
            "# edited on B\n"
        );
    }

    #[test]
    fn pending_local_changes_are_committed_then_merged() {
        // sync() commits pending changes BEFORE the merge decision, so an
        // uncommitted local edit becomes the local side of the merge — the
        // worktree is never merged over while dirty.
        let (a, _bare, b) = two_synced_clones();
        std::fs::write(a.path().join("a.md"), "# from A\n").unwrap();
        sync(a.path(), "A", "a@x", None).unwrap();
        // B's edit stays uncommitted until the sync cycle itself.
        std::fs::write(b.path().join("sub/b.md"), "# pending on B\n").unwrap();
        let out = sync(b.path(), "B", "b@x", None).unwrap();
        assert_eq!(out.kind, GitSyncKind::Merged);
        assert_eq!(
            std::fs::read_to_string(b.path().join("a.md")).unwrap(),
            "# from A\n"
        );
        assert_eq!(
            std::fs::read_to_string(b.path().join("sub/b.md")).unwrap(),
            "# pending on B\n"
        );
        // The merge's local parent carries the just-committed edit.
        let repo = Repository::open(b.path()).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let local_parent = head.parent(0).unwrap();
        let entry = local_parent
            .tree()
            .unwrap()
            .get_path(Path::new("sub/b.md"))
            .unwrap();
        let blob = repo.find_blob(entry.id()).unwrap();
        assert_eq!(blob.content(), b"# pending on B\n");
    }

    #[test]
    fn busy_repository_reports_diverged_not_merged() {
        let (a, _bare, b) = two_synced_clones();
        // Committed divergence on both sides (same file → would conflict).
        std::fs::write(a.path().join("a.md"), "# from A\n").unwrap();
        sync(a.path(), "A", "a@x", None).unwrap();
        std::fs::write(b.path().join("a.md"), "# from B\n").unwrap();
        assert!(matches!(
            sync(b.path(), "B", "b@x", None).unwrap().kind,
            GitSyncKind::Conflicted { .. }
        ));
        // User mid-merge in the adopted repo: never auto-merge over it.
        std::fs::write(b.path().join(".git/MERGE_HEAD"), "0000\n").unwrap();
        let out = sync(b.path(), "B", "b@x", None).unwrap();
        assert_eq!(out.kind, GitSyncKind::Diverged);
        assert!(
            b.path().join(".git/MERGE_HEAD").exists(),
            "the user's merge state must survive the cycle"
        );
        // Operation finished → the auto-merge path resumes.
        std::fs::remove_file(b.path().join(".git/MERGE_HEAD")).unwrap();
        assert!(matches!(
            sync(b.path(), "B", "b@x", None).unwrap().kind,
            GitSyncKind::Conflicted { .. }
        ));
    }

    #[test]
    fn curated_index_blocks_merge_checkout_loudly() {
        // commit_all skips when the index holds a manually staged partial
        // change; the merge checkout then hits a dirty file and must fail
        // loudly, leaving worktree and branch untouched.
        let (a, _bare, b) = two_synced_clones();
        std::fs::write(a.path().join("a.md"), "# from A\n").unwrap();
        sync(a.path(), "A", "a@x", None).unwrap();
        // B commits a non-conflicting edit, then curates the index for the
        // very file the merge needs to update.
        std::fs::write(b.path().join("sub/b.md"), "# from B\n").unwrap();
        commit_all(b.path(), "B", "b@x").unwrap().unwrap();
        std::fs::write(b.path().join("a.md"), "# staged v2\n").unwrap();
        {
            let repo = Repository::open(b.path()).unwrap();
            let mut index = repo.index().unwrap();
            index.add_path(Path::new("a.md")).unwrap();
            index.write().unwrap();
        }
        std::fs::write(b.path().join("a.md"), "# worktree v3\n").unwrap();
        let local_tip = head_id(b.path()).unwrap();
        let err = sync(b.path(), "B", "b@x", None).unwrap_err();
        assert!(matches!(err, CoreError::Internal(_)));
        assert_eq!(
            std::fs::read_to_string(b.path().join("a.md")).unwrap(),
            "# worktree v3\n",
            "dirty file must be untouched"
        );
        assert_eq!(head_id(b.path()).unwrap(), local_tip, "branch untouched");
        let repo = Repository::open(b.path()).unwrap();
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
    }

    #[test]
    fn merge_author_falls_back_to_defaults_instead_of_failing() {
        let (a, _bare, b) = two_synced_clones();
        std::fs::write(a.path().join("a.md"), "# from A\n").unwrap();
        sync(a.path(), "A", "a@x", None).unwrap();
        std::fs::write(b.path().join("sub/b.md"), "# from B\n").unwrap();
        let out = sync(b.path(), " ", "", None).unwrap();
        assert_eq!(out.kind, GitSyncKind::Merged);
        let repo = Repository::open(b.path()).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let author = head.author();
        assert_eq!(author.name().unwrap(), "Novalis");
        assert_eq!(author.email().unwrap(), "novalis@localhost");
    }

    #[test]
    fn set_remote_replaces_and_removes() {
        let dir = vault();
        ensure_repo(dir.path()).unwrap();
        set_remote(dir.path(), Some("https://example.com/a.git")).unwrap();
        set_remote(dir.path(), Some("https://example.com/b.git")).unwrap();
        assert_eq!(
            repo_status(dir.path()).unwrap().remote_url.as_deref(),
            Some("https://example.com/b.git")
        );
        set_remote(dir.path(), None).unwrap();
        assert!(repo_status(dir.path()).unwrap().remote_url.is_none());
    }
}
