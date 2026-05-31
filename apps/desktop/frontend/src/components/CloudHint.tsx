import { useEffect, useState } from "react";

import { Cloud, X } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import { useVault } from "../stores/vaultStore";

/** Detect a cloud-synced vault folder from its path. Such folders use
 *  "files on-demand" (online-only placeholders), so notes download on first
 *  open — worth telling the user about once. */
function cloudProvider(path: string | null): string | null {
  if (!path) return null;
  if (/OneDrive/i.test(path)) return "OneDrive";
  if (/Mobile Documents|com~apple~CloudDocs|iCloud/i.test(path)) return "iCloud Drive";
  if (/Dropbox/i.test(path)) return "Dropbox";
  if (/Google ?Drive/i.test(path)) return "Google Drive";
  if (/CloudStorage/i.test(path)) return "cloud storage";
  return null;
}

const dismissKey = (path: string) => `novalis:cloudHintDismissed:${path}`;

/** One-time, dismissible notice for cloud-synced vaults explaining that
 *  "online-only" files download on first open and how to make them instant. */
export function CloudHint() {
  const { t } = useTranslation("vault");
  const vaultPath = useVault((s) => s.vaultPath);
  const provider = cloudProvider(vaultPath);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (vaultPath && provider) {
      setDismissed(localStorage.getItem(dismissKey(vaultPath)) === "1");
    }
  }, [vaultPath, provider]);

  if (!vaultPath || !provider || dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(dismissKey(vaultPath), "1");
    setDismissed(true);
  };

  return (
    <div className="flex items-start gap-2.5 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs text-amber-200/90">
      <Cloud size={15} className="mt-0.5 shrink-0 text-amber-300/80" />
      <p className="min-w-0 flex-1 leading-relaxed">
        <Trans
          i18nKey="cloudHint"
          ns="vault"
          values={{ provider }}
          components={{ b: <span className="font-medium" /> }}
        />
      </p>
      <button
        onClick={dismiss}
        title={t("dismiss")}
        className="shrink-0 rounded p-0.5 text-amber-300/70 transition-colors hover:bg-active hover:text-amber-100"
      >
        <X size={14} />
      </button>
    </div>
  );
}
