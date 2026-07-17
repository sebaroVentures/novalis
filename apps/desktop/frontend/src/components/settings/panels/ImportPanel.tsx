import { useState } from "react";

import { FileUp, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, type ImportSummary } from "../../../ipc/api";
import { useVault } from "../../../stores/vaultStore";
import { SettingRow, SettingsSection } from "../../ui";

type Format = "notion" | "enex";

/** Settings panel to import notes from a Notion export `.zip` or an Evernote
 *  `.enex` file. Each importer opens a native file picker, writes into its own
 *  `Imported/…` subfolder without overwriting anything, and reindexes. */
export function ImportPanel() {
  const { t } = useTranslation("settings");
  const reportError = useVault((s) => s.reportError);
  const [running, setRunning] = useState<Format | null>(null);
  const [result, setResult] = useState<ImportSummary | null>(null);

  const run = (format: Format) => {
    if (running) return;
    setRunning(format);
    setResult(null);
    const call = format === "notion" ? api.importNotion() : api.importEnex();
    void call
      // A `null` summary means the user cancelled the file picker — leave the
      // panel untouched.
      .then((summary) => summary && setResult(summary))
      .catch((e) => reportError(e))
      .finally(() => setRunning(null));
  };

  const runButton = (format: Format, label: string) => (
    <button
      onClick={() => run(format)}
      disabled={running !== null}
      className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {running === format ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <FileUp size={14} />
      )}
      {running === format ? t("import.running") : label}
    </button>
  );

  return (
    <SettingsSection title={t("import.section")} description={t("import.desc")}>
      <SettingRow
        label={t("import.notion.label")}
        description={t("import.notion.desc")}
        control={runButton("notion", t("import.notion.button"))}
      />
      <SettingRow
        label={t("import.enex.label")}
        description={t("import.enex.desc")}
        control={runButton("enex", t("import.enex.button"))}
      />
      {result && (
        <div className="mt-3 space-y-1 rounded-xl bg-app/50 p-3 text-xs text-fg-muted">
          <p className="text-fg">{t("import.result.done", { folder: result.folder })}</p>
          <p>
            {t("import.result.counts", {
              notes: result.notesImported,
              rows: result.databaseRows,
              assets: result.assetsCopied,
            })}
          </p>
          {result.skipped > 0 && (
            <p className="text-danger">
              {t("import.result.skipped", { count: result.skipped })}
            </p>
          )}
          {result.warnings.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-fg-subtle">
              {result.warnings.slice(0, 5).map((w) => (
                <li key={w} className="truncate">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
