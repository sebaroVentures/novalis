import { useEffect, useState, type ReactNode } from "react";

import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, type FeaturePrefs } from "../../../ipc/api";
import {
  resolveFeaturePrefs,
  resolveGitPrefs,
  useSettings,
} from "../../../stores/settingsStore";
import { useVault } from "../../../stores/vaultStore";
import { SettingRow, SettingsSection, Switch } from "../../ui";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { PanelLoading } from "./PanelLoading";

type FlagKey = keyof Required<FeaturePrefs>;

/** One feature toggle bound to Preferences.features. Labels arrive already
 *  translated so every t() call below stays a static literal. */
function FeatureRow({
  flag,
  checked,
  label,
  description,
  aria,
  disabled,
  onToggled,
}: {
  flag: FlagKey;
  checked: boolean;
  label: string;
  description: string;
  aria: string;
  disabled?: boolean;
  /** Called after the flag is written — the enable-time setup offers hook. */
  onToggled?: (v: boolean) => void;
}) {
  return (
    <SettingRow
      label={label}
      description={description}
      control={
        <Switch
          checked={checked}
          disabled={disabled}
          onChange={(v) => {
            useSettings.getState().setFeatures({ [flag]: v });
            onToggled?.(v);
          }}
          aria-label={aria}
        />
      }
    />
  );
}

/** Indents the AI sub-toggles under the master switch. */
function SubRows({ children }: { children: ReactNode }) {
  return <div className="ml-1 border-l border-border pl-4">{children}</div>;
}

export function FeaturesPanel() {
  const { t } = useTranslation("settings");
  const prefs = useSettings((s) => s.prefs);
  // Session-local enable-time setup offers (decision: enabling a feature
  // offers its one-time setup instead of silently doing nothing).
  const [offerAiSetup, setOfferAiSetup] = useState(false);
  const [offerReindex, setOfferReindex] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  if (!prefs) return <PanelLoading />;

  const settings = useSettings.getState();
  const f = resolveFeaturePrefs(prefs.features);
  const git = resolveGitPrefs(prefs.git);

  const reindexNow = async () => {
    setReindexing(true);
    try {
      // Progress shows on the global reindex bar (index-progress events).
      await api.reindexVault();
      setOfferReindex(false);
    } catch (e) {
      // A caught rejection never reaches the unhandled-rejection toast —
      // route it to the global error surface explicitly.
      useVault.getState().reportError(e);
    } finally {
      setReindexing(false);
    }
  };

  return (
    <>
      <SettingsSection
        title={t("features.sectionAi")}
        description={t("features.sectionAiDesc")}
      >
        <FeatureRow
          flag="ai"
          checked={f.ai}
          label={t("features.ai.label")}
          description={t("features.ai.desc")}
          aria={t("features.ai.aria")}
          onToggled={(v) => setOfferAiSetup(v)}
        />
        {offerAiSetup && f.ai && (
          <p className="px-1 pt-2 text-xs text-accent">{t("features.aiSetupOffer")}</p>
        )}
        <SubRows>
          {/* Ambient suggestions keep their canonical gate in
              EditorPrefs.ambientAi — this row is the same pref as
              Settings › AI, not a separate flag. */}
          <SettingRow
            label={t("features.ambient.label")}
            description={t("features.ambient.desc")}
            control={
              <Switch
                checked={prefs.editor?.ambientAi ?? false}
                disabled={!f.ai}
                onChange={(v) => settings.setEditor({ ambientAi: v })}
                aria-label={t("features.ambient.aria")}
              />
            }
          />
          <FeatureRow
            flag="aiMetaSuggestions"
            checked={f.aiMetaSuggestions}
            disabled={!f.ai}
            label={t("features.aiMetaSuggestions.label")}
            description={t("features.aiMetaSuggestions.desc")}
            aria={t("features.aiMetaSuggestions.aria")}
          />
          <FeatureRow
            flag="aiTemplates"
            checked={f.aiTemplates}
            disabled={!f.ai}
            label={t("features.aiTemplates.label")}
            description={t("features.aiTemplates.desc")}
            aria={t("features.aiTemplates.aria")}
          />
          <FeatureRow
            flag="taskExtract"
            checked={f.taskExtract}
            disabled={!f.ai}
            label={t("features.taskExtract.label")}
            description={t("features.taskExtract.desc")}
            aria={t("features.taskExtract.aria")}
          />
          <FeatureRow
            flag="weeklyReview"
            checked={f.weeklyReview}
            disabled={!f.ai}
            label={t("features.weeklyReview.label")}
            description={t("features.weeklyReview.desc")}
            aria={t("features.weeklyReview.aria")}
          />
          <FeatureRow
            flag="vaultChat"
            checked={f.vaultChat}
            disabled={!f.ai}
            label={t("features.vaultChat.label")}
            description={t("features.vaultChat.desc")}
            aria={t("features.vaultChat.aria")}
          />
          <FeatureRow
            flag="relatedNotes"
            checked={f.relatedNotes}
            disabled={!f.ai}
            label={t("features.relatedNotes.label")}
            description={t("features.relatedNotes.desc")}
            aria={t("features.relatedNotes.aria")}
          />
          <FeatureRow
            flag="entityGraph"
            checked={f.entityGraph}
            disabled={!f.ai}
            label={t("features.entityGraph.label")}
            description={t("features.entityGraph.desc")}
            aria={t("features.entityGraph.aria")}
          />
        </SubRows>
      </SettingsSection>

      <SettingsSection title={t("features.sectionEditor")}>
        <FeatureRow
          flag="blockRefs"
          checked={f.blockRefs}
          label={t("features.blockRefs.label")}
          description={t("features.blockRefs.desc")}
          aria={t("features.blockRefs.aria")}
          onToggled={(v) => setOfferReindex(v)}
        />
        {offerReindex && f.blockRefs && (
          <div className="flex items-center justify-between gap-3 px-1 pt-2">
            <p className="text-xs text-accent">{t("features.reindexOffer.text")}</p>
            <button
              type="button"
              onClick={() => void reindexNow()}
              disabled={reindexing}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {reindexing && <Loader2 size={13} className="animate-spin" />}
              {t("features.reindexOffer.action")}
            </button>
          </div>
        )}
        <FeatureRow
          flag="transclusion"
          checked={f.transclusion}
          label={t("features.transclusion.label")}
          description={t("features.transclusion.desc")}
          aria={t("features.transclusion.aria")}
        />
        <FeatureRow
          flag="mermaid"
          checked={f.mermaid}
          label={t("features.mermaid.label")}
          description={t("features.mermaid.desc")}
          aria={t("features.mermaid.aria")}
        />
        <FeatureRow
          flag="math"
          checked={f.math}
          label={t("features.math.label")}
          description={t("features.math.desc")}
          aria={t("features.math.aria")}
        />
        <FeatureRow
          flag="codeHighlight"
          checked={f.codeHighlight}
          label={t("features.codeHighlight.label")}
          description={t("features.codeHighlight.desc")}
          aria={t("features.codeHighlight.aria")}
        />
        <FeatureRow
          flag="callouts"
          checked={f.callouts}
          label={t("features.callouts.label")}
          description={t("features.callouts.desc")}
          aria={t("features.callouts.aria")}
        />
        <FeatureRow
          flag="tagAutocomplete"
          checked={f.tagAutocomplete}
          label={t("features.tagAutocomplete.label")}
          description={t("features.tagAutocomplete.desc")}
          aria={t("features.tagAutocomplete.aria")}
        />
        <FeatureRow
          flag="outline"
          checked={f.outline}
          label={t("features.outline.label")}
          description={t("features.outline.desc")}
          aria={t("features.outline.aria")}
        />
      </SettingsSection>

      <SettingsSection
        title={t("features.sectionWorkspace")}
        description={t("features.sectionWorkspaceDesc")}
      >
        <FeatureRow
          flag="todayView"
          checked={f.todayView}
          label={t("features.todayView.label")}
          description={t("features.todayView.desc")}
          aria={t("features.todayView.aria")}
        />
        <FeatureRow
          flag="tasks"
          checked={f.tasks}
          label={t("features.tasks.label")}
          description={t("features.tasks.desc")}
          aria={t("features.tasks.aria")}
        />
        <FeatureRow
          flag="calendar"
          checked={f.calendar}
          label={t("features.calendar.label")}
          description={t("features.calendar.desc")}
          aria={t("features.calendar.aria")}
        />
      </SettingsSection>

      <SettingsSection title={t("features.sectionGraph")}>
        <FeatureRow
          flag="backlinks"
          checked={f.backlinks}
          label={t("features.backlinks.label")}
          description={t("features.backlinks.desc")}
          aria={t("features.backlinks.aria")}
        />
        <FeatureRow
          flag="graphView"
          checked={f.graphView}
          label={t("features.graphView.label")}
          description={t("features.graphView.desc")}
          aria={t("features.graphView.aria")}
        />
        <FeatureRow
          flag="properties"
          checked={f.properties}
          label={t("features.properties.label")}
          description={t("features.properties.desc")}
          aria={t("features.properties.aria")}
        />
      </SettingsSection>

      <SettingsSection title={t("features.sectionPower")}>
        <FeatureRow
          flag="queryEngine"
          checked={f.queryEngine}
          label={t("features.queryEngine.label")}
          description={t("features.queryEngine.desc")}
          aria={t("features.queryEngine.aria")}
        />
        <FeatureRow
          flag="dailyNotes"
          checked={f.dailyNotes}
          label={t("features.dailyNotes.label")}
          description={t("features.dailyNotes.desc")}
          aria={t("features.dailyNotes.aria")}
        />
        <FeatureRow
          flag="plugins"
          checked={f.plugins}
          label={t("features.plugins.label")}
          description={t("features.plugins.desc")}
          aria={t("features.plugins.aria")}
        />
        <FeatureRow
          flag="reminders"
          checked={f.reminders}
          label={t("features.reminders.label")}
          description={t("features.reminders.desc")}
          aria={t("features.reminders.aria")}
        />
      </SettingsSection>

      <SettingsSection title={t("features.sectionSync")}>
        {/* Git sync keeps its canonical gate in GitPrefs.enabled — this row is
            the same pref as Settings › Sync, not a separate flag. */}
        <SettingRow
          label={t("features.git.label")}
          description={t("features.git.desc")}
          control={
            <Switch
              checked={git.enabled}
              onChange={(v) => settings.setGit({ enabled: v })}
              aria-label={t("features.git.aria")}
            />
          }
        />
        <FeatureRow
          flag="p2pSync"
          checked={f.p2pSync}
          label={t("features.p2pSync.label")}
          description={t("features.p2pSync.desc")}
          aria={t("features.p2pSync.aria")}
        />
        <FeatureRow
          flag="calendarSync"
          checked={f.calendarSync}
          label={t("features.calendarSync.label")}
          description={t("features.calendarSync.desc")}
          aria={t("features.calendarSync.aria")}
        />
        <FeatureRow
          flag="icsSubscriptions"
          checked={f.icsSubscriptions}
          label={t("features.icsSubscriptions.label")}
          description={t("features.icsSubscriptions.desc")}
          aria={t("features.icsSubscriptions.aria")}
        />
      </SettingsSection>

      <SettingsSection title={t("features.sectionMedia")}>
        <FeatureRow
          flag="canvas"
          checked={f.canvas}
          label={t("features.canvas.label")}
          description={t("features.canvas.desc")}
          aria={t("features.canvas.aria")}
        />
        <FeatureRow
          flag="pdfAnnotate"
          checked={f.pdfAnnotate}
          label={t("features.pdfAnnotate.label")}
          description={t("features.pdfAnnotate.desc")}
          aria={t("features.pdfAnnotate.aria")}
        />
        <FeatureRow
          flag="voice"
          checked={f.voice}
          label={t("features.voice.label")}
          description={t("features.voice.desc")}
          aria={t("features.voice.aria")}
        />
      </SettingsSection>

      <StorageSection />
    </>
  );
}

type StorageTarget = "embeddings" | "entities" | "voiceModel";

/** "Delete & free space" (decision: disabling keeps data; deleting is a
 *  separate, explicit, confirmed action). The commands are deliberately
 *  available while the features are off — leftovers are exactly what a
 *  switched-off feature accumulates. */
function StorageSection() {
  const { t } = useTranslation("settings");
  const [confirm, setConfirm] = useState<StorageTarget | null>(null);
  const [busy, setBusy] = useState<StorageTarget | null>(null);
  const [result, setResult] = useState<
    Partial<Record<StorageTarget, { ok: boolean; text: string }>>
  >({});
  const [voiceModelBytes, setVoiceModelBytes] = useState<number | null>(null);

  useEffect(() => {
    api
      .voiceModelStatus()
      .then(setVoiceModelBytes)
      .catch(() => setVoiceModelBytes(null));
  }, []);

  // Honest rounding for freed-space reports (0 stays 0); the on-disk display
  // below floors at 1 so a real file never reads "0 MB".
  const mb = (bytes: number) => Math.round(bytes / 1_000_000);

  const ok = (target: StorageTarget, text: string) =>
    setResult((r) => ({ ...r, [target]: { ok: true, text } }));

  const run = async (target: StorageTarget) => {
    setConfirm(null);
    setBusy(target);
    try {
      if (target === "embeddings") {
        const freed = await api.aiDeleteEmbeddings();
        ok(target, t("features.storage.freed", { mb: mb(freed.bytes) }));
      } else if (target === "entities") {
        const rows = await api.entitiesDeleteAll();
        ok(target, t("features.storage.freedRows", { n: rows }));
      } else {
        const bytes = await api.voiceDeleteModel();
        setVoiceModelBytes(0);
        ok(target, t("features.storage.freed", { mb: mb(bytes) }));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setResult((r) => ({ ...r, [target]: { ok: false, text: message } }));
    } finally {
      setBusy(null);
    }
  };

  const deleteButton = (target: StorageTarget, aria: string, disabled?: boolean) => (
    <button
      type="button"
      onClick={() => setConfirm(target)}
      disabled={busy !== null || disabled}
      aria-label={aria}
      className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-danger transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy === target && <Loader2 size={13} className="animate-spin" />}
      {t("features.storage.action")}
    </button>
  );

  // Success and failure must not read alike: results render on their own
  // line, errors in the danger color like every other panel's error slot.
  // (Hoisted to variables — the i18n lint rule reads inline string args in
  // JSX expression containers as untranslated literals.)
  const resultLine = (target: StorageTarget) => {
    const r = result[target];
    if (!r) return null;
    return (
      <p className={`px-1 pt-1 text-xs ${r.ok ? "text-fg-subtle" : "text-danger"}`} role={r.ok ? undefined : "alert"}>
        {r.text}
      </p>
    );
  };
  const embeddingsResult = resultLine("embeddings");
  const entitiesResult = resultLine("entities");
  const voiceModelResult = resultLine("voiceModel");

  return (
    <SettingsSection
      title={t("features.sectionStorage")}
      description={t("features.sectionStorageDesc")}
    >
      <SettingRow
        label={t("features.storage.embeddings.label")}
        description={t("features.storage.embeddings.desc")}
        control={deleteButton("embeddings", t("features.storage.embeddings.aria"))}
      />
      {embeddingsResult}
      <SettingRow
        label={t("features.storage.entities.label")}
        description={t("features.storage.entities.desc")}
        control={deleteButton("entities", t("features.storage.entities.aria"))}
      />
      {entitiesResult}
      <SettingRow
        label={t("features.storage.voiceModel.label")}
        description={
          voiceModelBytes && voiceModelBytes > 0
            ? t("features.storage.voiceModel.descDownloaded", {
                mb: Math.max(1, mb(voiceModelBytes)),
              })
            : t("features.storage.voiceModel.desc")
        }
        control={deleteButton(
          "voiceModel",
          t("features.storage.voiceModel.aria"),
          !voiceModelBytes,
        )}
      />
      {voiceModelResult}

      <ConfirmDialog
        open={confirm === "embeddings"}
        title={t("features.storage.embeddings.confirmTitle")}
        body={t("features.storage.embeddings.confirmBody")}
        confirmLabel={t("features.storage.action")}
        danger
        onConfirm={() => void run("embeddings")}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "entities"}
        title={t("features.storage.entities.confirmTitle")}
        body={t("features.storage.entities.confirmBody")}
        confirmLabel={t("features.storage.action")}
        danger
        onConfirm={() => void run("entities")}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === "voiceModel"}
        title={t("features.storage.voiceModel.confirmTitle")}
        body={t("features.storage.voiceModel.confirmBody")}
        confirmLabel={t("features.storage.action")}
        danger
        onConfirm={() => void run("voiceModel")}
        onCancel={() => setConfirm(null)}
      />
    </SettingsSection>
  );
}
