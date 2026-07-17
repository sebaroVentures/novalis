import { useEffect, useState } from "react";

import { FolderX } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import { api, type RecentVault } from "../ipc/api";
import { useVault } from "../stores/vaultStore";

const vaultName = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

/** Shown when no vault is open: prompts the user to pick a folder, and offers
 *  one-click access to recently opened vaults. */
export function VaultGate() {
  const { t } = useTranslation(["vault", "common"]);
  const pickAndOpen = useVault((s) => s.pickAndOpen);
  const takeTour = useVault((s) => s.takeTour);
  const switchVault = useVault((s) => s.switchVault);
  const error = useVault((s) => s.error);
  const [recent, setRecent] = useState<RecentVault[]>([]);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  // Mobile has no folder picker: the vault lives app-private and is populated
  // via the git adoption path (MOBILE.md). Until the platform is known the
  // action area stays empty to avoid flashing the wrong flow.
  const [platform, setPlatform] = useState<string | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteToken, setRemoteToken] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .platformInfo()
      .then(setPlatform)
      .catch(() => setPlatform("desktop"));
  }, []);
  const mobile = platform === "android" || platform === "ios";

  const openLocalVault = async () => {
    setBusy(true);
    try {
      await switchVault(await api.defaultVaultPath());
    } finally {
      setBusy(false);
    }
  };

  const cloneRemote = async () => {
    setBusy(true);
    try {
      // Open the empty app-private vault first — the P2a adoption path then
      // pulls the remote's content into it on the first sync.
      await switchVault(await api.defaultVaultPath());
      await api.gitSetRemote(remoteUrl.trim());
      if (remoteToken.trim()) await api.gitSetToken(remoteToken.trim());
      await api.gitSyncNow();
      // No watcher on mobile: rescan so the cloned notes appear.
      await api.rescanVault();
      await useVault.getState().sync();
    } catch (e) {
      useVault.getState().reportError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await api.listRecentVaults();
        if (!active) return;
        setRecent(list);
        const gone = new Set<string>();
        await Promise.all(
          list.map(async (v) => {
            try {
              await api.validateVault(v.path);
            } catch {
              gone.add(v.path);
            }
          }),
        );
        if (active) setMissing(gone);
      } catch {
        /* no recent vaults to show */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const removeRecent = async (path: string) => {
    await api.removeRecentVault(path).catch(() => {});
    setRecent((r) => r.filter((v) => v.path !== path));
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-app text-fg">
      <div className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight">{t("appName")}</h1>
        <p className="mt-2 text-fg-subtle">{t("tagline")}</p>
      </div>
      {platform !== null && !mobile && (
        <div className="flex flex-col items-center gap-2">
          <button
            onClick={() => void takeTour()}
            disabled={busy}
            className="rounded-lg bg-accent px-5 py-2.5 font-medium text-accent-fg transition hover:bg-accent disabled:opacity-50"
          >
            {t("takeTour")}
          </button>
          <button
            onClick={() => void pickAndOpen()}
            disabled={busy}
            className="rounded-lg px-4 py-1.5 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
          >
            {t("openVault")}
          </button>
        </div>
      )}

      {mobile && (
        <div className="flex w-full max-w-sm flex-col items-stretch gap-3 px-6">
          <button
            onClick={() => void openLocalVault()}
            disabled={busy}
            className="rounded-lg bg-accent px-5 py-2.5 font-medium text-accent-fg transition hover:bg-accent disabled:opacity-50"
          >
            {busy && !remoteOpen ? t("common:loading") : t("mobileLocal")}
          </button>
          {!remoteOpen ? (
            <button
              onClick={() => setRemoteOpen(true)}
              disabled={busy}
              className="rounded-lg border border-border px-5 py-2.5 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
            >
              {t("mobileConnect")}
            </button>
          ) : (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <input
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                placeholder={t("mobileUrl")}
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                className="rounded-md border border-border bg-app px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <input
                value={remoteToken}
                onChange={(e) => setRemoteToken(e.target.value)}
                placeholder={t("mobileToken")}
                type="password"
                autoCapitalize="off"
                autoCorrect="off"
                className="rounded-md border border-border bg-app px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:outline-none focus:ring-1 focus:ring-accent"
              />
              <button
                onClick={() => void cloneRemote()}
                disabled={busy || !remoteUrl.trim().startsWith("https://")}
                className="rounded-lg bg-accent px-5 py-2 font-medium text-accent-fg transition hover:bg-accent disabled:opacity-50"
              >
                {busy ? t("common:loading") : t("mobileClone")}
              </button>
            </div>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <div className="w-full max-w-sm">
          <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
            {t("recentVaults")}
          </p>
          <ul className="overflow-hidden rounded-lg border border-border/80">
            {recent.map((v) => {
              const gone = missing.has(v.path);
              return (
                <li
                  key={v.path}
                  className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2 last:border-0"
                >
                  <button
                    onClick={() => void switchVault(v.path)}
                    disabled={gone}
                    title={v.path}
                    className="flex min-w-0 flex-1 flex-col items-start text-left disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="truncate text-sm text-fg">{vaultName(v.path)}</span>
                    <span className="w-full truncate text-xs text-fg-subtle">{v.path}</span>
                  </button>
                  {gone && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-danger">
                      <FolderX size={13} />
                      {t("vaultMissing")}
                    </span>
                  )}
                  <button
                    onClick={() => void removeRecent(v.path)}
                    className="shrink-0 rounded-md px-2 py-1 text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
                  >
                    {t("common:remove")}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <p className="max-w-sm px-6 text-center text-xs text-fg-faint">
        {mobile ? (
          t("mobileHint")
        ) : (
          <Trans i18nKey="chooseHint" ns="vault">
            Choose a folder of Markdown files (e.g. your OneDrive NexusNotes folder). Novalis reads
            and writes plain <code>.md</code> files — nothing leaves your device.
          </Trans>
        )}
      </p>
      {error && <p className="text-sm text-danger">{error}</p>}
    </main>
  );
}
