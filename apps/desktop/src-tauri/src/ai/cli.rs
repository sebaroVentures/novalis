//! Local CLI provider adapter for Claude Code (`claude`) and OpenAI Codex
//! (`codex`). These run with the user's own login/subscription — no API key.
//!
//! We spawn the binary directly (never via a shell), feed a self-contained
//! prompt over stdin, stream stdout back as text, and kill the child on cancel.
//! The binary is resolved to an absolute path because a bundled GUI app does
//! not inherit the user's interactive-shell `PATH`.
//!
//! The exact flags are conservative and may need tweaking per CLI version:
//!   claude: `claude -p --output-format text --allowedTools "" [--model M]`  (stdin = prompt)
//!   codex:  `codex exec --skip-git-repo-check --sandbox read-only [--model M] -`  (stdin = prompt)

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

use novalis_core::ai::BuiltPrompt;
use novalis_core::models::{AiProviderKind, Usage};

use super::AiRequest;
use crate::engine::CommandError;

/// The expected executable base name for a CLI kind.
fn bin_name(kind: AiProviderKind) -> &'static str {
    match kind {
        AiProviderKind::ClaudeCli => "claude",
        AiProviderKind::CodexCli => "codex",
        _ => "",
    }
}

/// Executable filenames to try (Windows shims are `.cmd`/`.exe`).
fn candidate_names(base: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![
            format!("{base}.cmd"),
            format!("{base}.exe"),
            base.to_string(),
        ]
    } else {
        vec![base.to_string()]
    }
}

/// Common install locations to probe when `PATH` doesn't have the binary
/// (GUI apps often launch with a minimal `PATH`).
fn common_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join(".npm-global/bin"));
    }
    if cfg!(target_os = "macos") {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    } else if cfg!(target_os = "linux") {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
    } else if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
            dirs.push(appdata.join("npm"));
        }
    }
    dirs
}

/// Resolve the binary to an absolute path: an explicit override first, then
/// `PATH`, then common install dirs. Returns `None` if not found.
pub fn resolve_binary(kind: AiProviderKind, override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(ov) = override_path.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(ov);
        return p.is_file().then_some(p);
    }
    let base = bin_name(kind);
    if base.is_empty() {
        return None;
    }
    let names = candidate_names(base);
    let path_dirs = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default();
    for dir in path_dirs.into_iter().chain(common_dirs()) {
        for n in &names {
            let cand = dir.join(n);
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// Whether the CLI for `kind` is present.
pub fn is_available(kind: AiProviderKind, override_path: Option<&str>) -> bool {
    resolve_binary(kind, override_path).is_some()
}

fn not_found(kind: AiProviderKind) -> CommandError {
    CommandError {
        kind: "aiBadRequest".to_string(),
        message: format!(
            "the {} CLI was not found — install it or set an explicit path",
            bin_name(kind)
        ),
    }
}

fn launch_err(kind: AiProviderKind, e: std::io::Error) -> CommandError {
    CommandError {
        kind: "aiNetwork".to_string(),
        message: format!("failed to launch {}: {e}", bin_name(kind)),
    }
}

/// The file tools an agentic Claude run is allowed to use — scoped to reading
/// and editing the vault's files (no shell, no network, no MCP).
const AGENTIC_CLAUDE_TOOLS: &str = "Read Edit Write Glob Grep";

fn build_args(kind: AiProviderKind, model: &str, agentic: bool) -> Vec<String> {
    let model = model.trim();
    match kind {
        AiProviderKind::ClaudeCli => {
            let mut a = vec!["-p".into(), "--output-format".into(), "text".into()];
            if agentic {
                // Run as an editing agent over the vault: a curated file toolset
                // with edits auto-accepted (no interactive prompt in -p mode).
                a.push("--allowedTools".into());
                a.push(AGENTIC_CLAUDE_TOOLS.into());
                a.push("--permission-mode".into());
                a.push("acceptEdits".into());
            } else {
                // No tools: pure text generation over the prompt we pass.
                a.push("--allowedTools".into());
                a.push(String::new());
            }
            if !model.is_empty() {
                a.push("--model".into());
                a.push(model.into());
            }
            a
        }
        AiProviderKind::CodexCli => {
            let mut a = vec![
                "exec".into(),
                "--skip-git-repo-check".into(),
                "--sandbox".into(),
                // Agentic: let it write within its working directory (the
                // vault); otherwise read-only.
                if agentic {
                    "workspace-write".into()
                } else {
                    "read-only".into()
                },
            ];
            if !model.is_empty() {
                a.push("--model".into());
                a.push(model.into());
            }
            a.push("-".into()); // read the prompt from stdin
            a
        }
        _ => Vec::new(),
    }
}

/// Flatten a [`BuiltPrompt`] into a single text prompt for a one-shot CLI run.
fn render_prompt(prompt: &BuiltPrompt) -> String {
    let body = prompt
        .messages
        .iter()
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    if prompt.system.trim().is_empty() {
        body
    } else {
        format!("{}\n\n{}", prompt.system, body)
    }
}

/// Decode the longest valid UTF-8 prefix of `pending`, emit it, and keep any
/// trailing bytes of a split multi-byte char for the next read.
fn drain_utf8(pending: &mut Vec<u8>) -> String {
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) => {
            let valid = e.valid_up_to();
            let out = String::from_utf8_lossy(&pending[..valid]).to_string();
            pending.drain(..valid);
            out
        }
    }
}

/// Run a one-shot CLI completion, streaming stdout via `on_text`. Cooperatively
/// cancellable: a cancel kills the child and returns the partial result.
pub async fn stream<F: FnMut(&str)>(
    req: AiRequest,
    cancel: Arc<Notify>,
    mut on_text: F,
) -> Result<Usage, CommandError> {
    let bin =
        resolve_binary(req.kind, req.base_url.as_deref()).ok_or_else(|| not_found(req.kind))?;

    // Agentic runs execute INSIDE the vault with file tools; everything else
    // runs in a temp dir with no tools so the CLI can't touch the user's notes.
    // Agentic is honored only when a working dir (the vault) was provided.
    let agentic = req.agentic && req.workdir.is_some();
    let workdir = match &req.workdir {
        Some(dir) if agentic => dir.clone(),
        _ => std::env::temp_dir(),
    };

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(build_args(req.kind, &req.model, agentic))
        .current_dir(workdir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| launch_err(req.kind, e))?;

    // Feed the prompt over stdin, then close it.
    if let Some(mut stdin) = child.stdin.take() {
        let prompt = render_prompt(&req.prompt);
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }

    // Drain stderr concurrently so a chatty child (codex streams progress to
    // stderr) can't deadlock by filling the pipe while we only read stdout.
    let stderr = child.stderr.take();
    let stderr_handle = tokio::spawn(async move {
        let mut s = String::new();
        if let Some(mut e) = stderr {
            let _ = e.read_to_string(&mut s).await;
        }
        s
    });

    let mut stdout = child.stdout.take().ok_or_else(|| CommandError {
        kind: "aiNetwork".to_string(),
        message: "could not capture CLI stdout".to_string(),
    })?;

    let mut buf = [0u8; 4096];
    let mut pending: Vec<u8> = Vec::new();
    let cancelled = cancel.notified();
    tokio::pin!(cancelled);

    loop {
        tokio::select! {
            _ = &mut cancelled => {
                let _ = child.kill().await;
                return Ok(Usage::default());
            }
            read = stdout.read(&mut buf) => match read {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = drain_utf8(&mut pending);
                    if !text.is_empty() {
                        on_text(&text);
                    }
                }
                Err(e) => {
                    let _ = child.kill().await;
                    return Err(CommandError {
                        kind: "aiNetwork".to_string(),
                        message: format!("error reading {} output: {e}", bin_name(req.kind)),
                    });
                }
            }
        }
    }

    // Flush any trailing bytes (lossy — a clean stream ends on a char boundary).
    if !pending.is_empty() {
        on_text(&String::from_utf8_lossy(&pending));
    }

    let status = child.wait().await.map_err(|e| launch_err(req.kind, e))?;
    let stderr_text = stderr_handle.await.unwrap_or_default();

    if !status.success() {
        let detail = stderr_text
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{} exited with {status}", bin_name(req.kind)));
        return Err(CommandError {
            kind: "aiServer".to_string(),
            message: detail,
        });
    }

    Ok(Usage::default())
}

/// Validate a CLI connection: the binary resolves and `--version` runs cleanly.
pub async fn test(kind: AiProviderKind, override_path: Option<&str>) -> Result<(), CommandError> {
    let bin = resolve_binary(kind, override_path).ok_or_else(|| not_found(kind))?;
    let out = tokio::process::Command::new(&bin)
        .arg("--version")
        .current_dir(std::env::temp_dir())
        .output()
        .await
        .map_err(|e| launch_err(kind, e))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(CommandError {
            kind: "aiServer".to_string(),
            message: format!("`{} --version` failed", bin_name(kind)),
        })
    }
}
