import { Trans, useTranslation } from "react-i18next";

import { useVault } from "../stores/vaultStore";

/** Shown when no vault is open: prompts the user to pick a folder. */
export function VaultGate() {
  const { t } = useTranslation("vault");
  const pickAndOpen = useVault((s) => s.pickAndOpen);
  const error = useVault((s) => s.error);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-app text-fg">
      <div className="text-center">
        <h1 className="text-4xl font-semibold tracking-tight">{t("appName")}</h1>
        <p className="mt-2 text-fg-subtle">{t("tagline")}</p>
      </div>
      <button
        onClick={() => void pickAndOpen()}
        className="rounded-lg bg-accent px-5 py-2.5 font-medium text-accent-fg transition hover:bg-accent"
      >
        {t("openVault")}
      </button>
      <p className="max-w-sm text-center text-xs text-fg-faint">
        <Trans i18nKey="chooseHint" ns="vault">
          Choose a folder of Markdown files (e.g. your OneDrive NexusNotes folder). Novalis reads and
          writes plain <code>.md</code> files — nothing leaves your device.
        </Trans>
      </p>
      {error && <p className="text-sm text-danger">{error}</p>}
    </main>
  );
}
