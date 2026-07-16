import { useCallback, useEffect, useState } from "react";

import { Copy, GitCommitHorizontal, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  api,
  type GitStatus,
  type GitSyncKind,
  type GitSyncOutcome,
  type SyncOutcome,
  type SyncStatus,
} from "../../../ipc/api";
import { useGitConflicts } from "../../../stores/gitConflictStore";
import { resolveGitPrefs, useSettings } from "../../../stores/settingsStore";
import { NumberField, SettingRow, SettingsSection, Switch, TextField } from "../../ui";
import { PanelLoading } from "./PanelLoading";

// Static key map (typed i18next rejects template-built keys). `conflicted`
// is the only data-carrying kind — it crosses IPC as an object and is
// rendered separately.
const OUTCOME_KEY = {
  upToDate: "sync.outcome.upToDate",
  pushed: "sync.outcome.pushed",
  pulled: "sync.outcome.pulled",
  merged: "sync.outcome.merged",
  diverged: "sync.outcome.diverged",
  noRemote: "sync.outcome.noRemote",
} as const satisfies Record<Extract<GitSyncKind, string>, string>;
// i18next-parser only scans static t() literals; the outcome message resolves at
// runtime via t(OUTCOME_KEY[outcome.kind]), so list the keys to keep them alive.
// t("settings:sync.outcome.upToDate")
// t("settings:sync.outcome.pushed")
// t("settings:sync.outcome.pulled")
// t("settings:sync.outcome.merged")
// t("settings:sync.outcome.diverged")
// t("settings:sync.outcome.noRemote")

/** The conflict path list of a `Conflicted` outcome, or null for the rest. */
function conflictPaths(outcome: GitSyncOutcome | null): string[] | null {
  if (!outcome || typeof outcome.kind === "string") return null;
  return outcome.kind.conflicted.paths;
}

/** Git sync settings: P1 local auto-commit + P2 https remote sync. */
export function SyncPanel() {
  const { t, i18n } = useTranslation("settings");
  const prefs = useSettings((s) => s.prefs);
  // Conflicts the background sync surfaced (the event handler loads them into
  // the resolver store) — the hint below must not depend on a manual sync.
  const bgConflicts = useGitConflicts((s) => s.conflicts);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<GitSyncOutcome | null>(null);
  // null = not editing; the field shows the persisted remote URL.
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [s, tok] = await Promise.all([api.gitStatus(), api.gitHasToken()]);
      setStatus(s);
      setHasToken(tok);
    } catch {
      // noVault — the repository section just shows the uninitialized state.
      setStatus(null);
    }
  }, []);

  // Initial fetch + poll while the panel is open: the background
  // auto-committer (and the user's own edits) move the dirty count, the
  // last commit, and ahead/behind underneath us.
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!prefs) return <PanelLoading />;

  const settings = useSettings.getState();
  const git = resolveGitPrefs(prefs.git);
  const remoteUrl = status?.remoteUrl ?? null;

  const run = async (op: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await op();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const commitNow = () =>
    run(async () => {
      // Flush the debounced settings persist first: the backend reads the
      // author from config.json, and a just-typed identity would otherwise
      // miss the (permanent) baseline commit.
      await useSettings.getState().flush();
      setStatus(await api.gitCommitNow());
    });

  const syncNow = () =>
    run(async () => {
      setOutcome(null);
      await useSettings.getState().flush();
      const out = await api.gitSyncNow();
      setOutcome(out);
      // A conflicted merge opens the resolution modal right away (it mounts
      // globally in App.tsx); the hint below keeps a re-open button.
      if (typeof out.kind !== "string") useGitConflicts.getState().openResolver();
      await refresh();
    });

  const toggle = (enabled: boolean) => {
    settings.setGit({ enabled });
    // Enabling creates the repository and a baseline commit right away, so
    // the user sees a working state instead of waiting for the first interval.
    if (enabled) void commitNow();
  };

  const saveRemoteUrl = () =>
    run(async () => {
      const next = (urlDraft ?? "").trim();
      if (urlDraft === null || next === (remoteUrl ?? "")) {
        setUrlDraft(null);
        return;
      }
      setStatus(await api.gitSetRemote(next === "" ? null : next));
      setUrlDraft(null);
    });

  const saveToken = () =>
    run(async () => {
      await api.gitSetToken(tokenDraft);
      setTokenDraft("");
      setHasToken(await api.gitHasToken());
    });

  const last = status?.lastCommit ?? null;
  // Manual outcome wins (it is the fresher signal right after "Sync now");
  // otherwise fall back to the resolver store, which background syncs fill.
  const conflicted =
    conflictPaths(outcome) ?? (bgConflicts.length > 0 ? bgConflicts.map((c) => c.path) : null);

  return (
    <>
      <SettingsSection title={t("sync.git.title")} description={t("sync.git.desc")}>
        <SettingRow
          label={t("sync.enabled.label")}
          description={t("sync.enabled.desc")}
          control={
            <Switch checked={git.enabled} onChange={toggle} aria-label={t("sync.enabled.label")} />
          }
        />
        <SettingRow
          label={t("sync.authorName.label")}
          description={t("sync.authorName.desc")}
          control={
            <TextField
              value={git.authorName}
              onChange={(e) => settings.setGit({ authorName: e.target.value })}
              className="w-48"
            />
          }
        />
        <SettingRow
          label={t("sync.authorEmail.label")}
          description={t("sync.authorEmail.desc")}
          control={
            <TextField
              value={git.authorEmail}
              onChange={(e) => settings.setGit({ authorEmail: e.target.value })}
              className="w-48"
            />
          }
        />
        <SettingRow
          label={t("sync.interval.label")}
          description={t("sync.interval.desc")}
          control={
            <NumberField
              value={git.autoCommitSecs}
              min={30}
              max={3600}
              step={30}
              suffix="s"
              onChange={(n) => settings.setGit({ autoCommitSecs: n })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection title={t("sync.remote.title")} description={t("sync.remote.desc")}>
        <SettingRow
          label={t("sync.remote.url.label")}
          description={t("sync.remote.url.desc")}
          control={
            <TextField
              value={urlDraft ?? remoteUrl ?? ""}
              placeholder="https://github.com/…"
              onChange={(e) => setUrlDraft(e.target.value)}
              onBlur={() => void saveRemoteUrl()}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="w-72"
            />
          }
        />
        <SettingRow
          label={t("sync.remote.token.label")}
          description={
            hasToken ? t("sync.remote.token.saved") : t("sync.remote.token.desc")
          }
          control={
            <span className="flex items-center gap-1.5">
              <TextField
                type="password"
                value={tokenDraft}
                placeholder={hasToken ? "••••••••" : t("sync.remote.token.placeholder")}
                onChange={(e) => setTokenDraft(e.target.value)}
                className="w-48"
              />
              <button
                type="button"
                onClick={() => void saveToken()}
                disabled={busy || (tokenDraft.trim() === "" && !hasToken)}
                className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {tokenDraft.trim() === "" && hasToken
                  ? t("sync.remote.token.remove")
                  : t("sync.remote.token.save")}
              </button>
            </span>
          }
        />
        <SettingRow
          label={t("sync.remote.syncNow")}
          description={
            outcome
              ? typeof outcome.kind === "string"
                ? t(OUTCOME_KEY[outcome.kind], { ahead: outcome.ahead, behind: outcome.behind })
                : t("sync.outcome.conflicted", { n: outcome.kind.conflicted.paths.length })
              : remoteUrl
                ? t("sync.remote.aheadBehind", {
                    ahead: status?.ahead ?? 0,
                    behind: status?.behind ?? 0,
                  })
                : t("sync.remote.notConfigured")
          }
          control={
            <button
              type="button"
              onClick={() => void syncNow()}
              disabled={busy || !remoteUrl}
              className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              {t("sync.remote.syncNow")}
            </button>
          }
        />
        {outcome?.kind === "diverged" && (
          <p className="pt-2 text-xs text-danger">{t("sync.remote.divergedHint")}</p>
        )}
        {conflicted && (
          <div className="pt-2 text-xs text-danger">
            <p>{t("sync.remote.conflictedHint")}</p>
            <ul className="mt-1 list-inside list-disc">
              {conflicted.map((p) => (
                <li key={p} className="font-mono">
                  {p}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => useGitConflicts.getState().openResolver()}
              className="mt-2 rounded-md border border-border px-2.5 py-1 text-xs text-fg transition-colors hover:bg-hover"
            >
              {t("sync.remote.resolve")}
            </button>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t("sync.repo.title")}>
        {status?.initialized ? (
          <>
            <SettingRow
              label={t("sync.repo.lastCommit")}
              description={
                last
                  ? `${last.message} · ${last.id.slice(0, 7)} · ${new Date(last.time).toLocaleString(i18n.language)}`
                  : t("sync.repo.noCommits")
              }
              control={
                <CommitNowButton
                  busy={busy}
                  onClick={() => void commitNow()}
                  label={t("sync.repo.commitNow")}
                />
              }
            />
            <SettingRow
              label={t("sync.repo.pending")}
              description={
                status.branch ? t("sync.repo.onBranch", { branch: status.branch }) : undefined
              }
              control={
                <span className="text-sm text-fg-muted">
                  {t("sync.repo.pendingCount", { n: status.dirty })}
                </span>
              }
            />
          </>
        ) : (
          <SettingRow
            label={t("sync.repo.uninitialized")}
            description={t("sync.repo.uninitializedDesc")}
            control={
              <CommitNowButton
                busy={busy}
                onClick={() => void commitNow()}
                label={t("sync.repo.commitNow")}
              />
            }
          />
        )}
        {error && (
          <p className="pt-2 text-xs text-danger">{t("sync.repo.commitFailed", { message: error })}</p>
        )}
      </SettingsSection>

      <P2PSyncSection />
    </>
  );
}

// i18next-parser only scans static t() literals; the P2P outcome message
// resolves at runtime via t(P2P_OUTCOME[kind]), so list the keys to keep them.
// t("settings:sync.p2p.outcome.synced")
// t("settings:sync.p2p.outcome.upToDate")
// t("settings:sync.p2p.outcome.noPeers")
// t("settings:sync.p2p.outcome.notConfigured")
// t("settings:sync.p2p.outcome.unreachable")
const P2P_OUTCOME = {
  synced: "sync.p2p.outcome.synced",
  upToDate: "sync.p2p.outcome.upToDate",
  noPeers: "sync.p2p.outcome.noPeers",
  notConfigured: "sync.p2p.outcome.notConfigured",
  peerUnreachable: "sync.p2p.outcome.unreachable",
} as const satisfies Record<SyncOutcome["kind"], string>;

/**
 * W4.4 peer-to-peer, end-to-end-encrypted sync: an opt-in alternative to the
 * Git backend above. The frontend is thin — the backend owns identity, crypto,
 * pairing and transport; this panel drives generate-ticket / join / sync-now
 * and surfaces status. Divergences land as conflict copies handled by the
 * existing conflict resolver, so there is no bespoke merge UI here.
 */
function P2PSyncSection() {
  const { t, i18n } = useTranslation("settings");
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [joinDraft, setJoinDraft] = useState("");
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.syncStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [refresh]);

  const run = async (op: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await op();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const generate = () =>
    run(async () => {
      setTicket(await api.syncGenerateTicket());
      setCopied(false);
      await refresh();
    });

  const copyTicket = async () => {
    if (!ticket) return;
    try {
      await navigator.clipboard.writeText(ticket);
      setCopied(true);
    } catch {
      // Clipboard denied — the code is visible for a manual copy.
    }
  };

  const join = () =>
    run(async () => {
      const code = joinDraft.trim();
      if (!code) return;
      await api.syncJoin(code);
      setJoinDraft("");
      await refresh();
    });

  const syncNow = () =>
    run(async () => {
      setOutcome(null);
      setOutcome(await api.syncNow());
      await refresh();
    });

  const online = status?.listening ?? false;
  const shortId = status?.nodeId ? status.nodeId.slice(0, 8) : null;
  const peers = status?.peers ?? [];

  const outcomeText = outcome
    ? t(P2P_OUTCOME[outcome.kind], { taken: outcome.taken, sent: outcome.sent })
    : null;

  return (
    <SettingsSection title={t("sync.p2p.title")} description={t("sync.p2p.desc")}>
      <SettingRow
        label={
          online ? t("sync.p2p.status.online") : t("sync.p2p.status.offline")
        }
        description={
          shortId
            ? t("sync.p2p.status.thisDevice", { id: shortId })
            : t("sync.p2p.status.notConfigured")
        }
        control={
          <button
            type="button"
            onClick={() => void syncNow()}
            disabled={busy || peers.length === 0}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {t("sync.p2p.syncNow")}
          </button>
        }
      />

      <SettingRow
        label={t("sync.p2p.pair.title")}
        description={t("sync.p2p.pair.desc")}
        control={
          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy}
            className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("sync.p2p.pair.generate")}
          </button>
        }
      />

      {ticket && (
        <div className="pt-1">
          <label className="mb-1 block text-xs text-fg-muted">
            {t("sync.p2p.pair.ticketLabel")}
          </label>
          <div className="flex items-start gap-1.5">
            <textarea
              readOnly
              value={ticket}
              rows={3}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full resize-none rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[11px] text-fg"
            />
            <button
              type="button"
              onClick={() => void copyTicket()}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1.5 text-xs text-fg transition-colors hover:bg-hover"
            >
              <Copy size={13} />
              {copied ? t("sync.p2p.pair.copied") : t("sync.p2p.pair.copy")}
            </button>
          </div>
        </div>
      )}

      <SettingRow
        label={t("sync.p2p.pair.joinLabel")}
        control={
          <span className="flex items-center gap-1.5">
            <TextField
              value={joinDraft}
              placeholder={t("sync.p2p.pair.joinPlaceholder")}
              onChange={(e) => setJoinDraft(e.target.value)}
              className="w-56"
            />
            <button
              type="button"
              onClick={() => void join()}
              disabled={busy || joinDraft.trim() === ""}
              className="rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("sync.p2p.pair.joinBtn")}
            </button>
          </span>
        }
      />

      <SettingRow
        label={t("sync.p2p.peers.title")}
        control={
          <span className="text-sm text-fg-muted">
            {peers.length === 0 ? t("sync.p2p.peers.none") : peers.length}
          </span>
        }
      />
      {peers.length > 0 && (
        <ul className="space-y-1 pt-1 text-xs">
          {peers.map((p) => (
            <li key={p.nodeId} className="flex items-center justify-between gap-2">
              <span className="font-mono text-fg">{p.label}</span>
              <span className="text-fg-muted">
                {p.lastSyncedMs
                  ? t("sync.p2p.peers.lastSynced", {
                      when: new Date(p.lastSyncedMs).toLocaleString(i18n.language),
                    })
                  : t("sync.p2p.peers.never")}
              </span>
            </li>
          ))}
        </ul>
      )}

      {outcomeText && <p className="pt-2 text-xs text-fg-muted">{outcomeText}</p>}
      {outcome && outcome.skippedOversize > 0 && (
        <p className="pt-1 text-xs text-fg-muted">
          {t("sync.p2p.outcome.skippedOversize", { n: outcome.skippedOversize })}
        </p>
      )}
      {outcome && outcome.conflicts.length > 0 && (
        <p className="pt-1 text-xs text-danger">
          {t("sync.p2p.outcome.conflicts", { n: outcome.conflicts.length })}
        </p>
      )}
      {error && <p className="pt-2 text-xs text-danger">{t("sync.p2p.error", { message: error })}</p>}
    </SettingsSection>
  );
}

function CommitNowButton({
  busy,
  onClick,
  label,
}: {
  busy: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <GitCommitHorizontal size={14} />}
      {label}
    </button>
  );
}
