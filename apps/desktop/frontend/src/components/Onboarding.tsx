import { useState } from "react";

import {
  Calendar,
  CheckSquare,
  FileText,
  Network,
  PenLine,
  Presentation,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, NovalisError, type FeaturePrefs } from "../ipc/api";
import { useSettings } from "../stores/settingsStore";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";
import { Modal, Switch } from "./ui";

// First-run welcome. Shown once per device (gated on uiStore.onboardingDone in
// App), it gives a one-screen tour of the four pillars, then asks once which
// optional feature families this vault needs (written to the vault-synced
// Preferences.features — fine-tunable later in Settings › Features), and
// offers to seed a starter note so the vault isn't a blank canvas. Skippable
// via the button, the X, or Escape — every exit path marks onboarding done.

// i18next-parser only scans static t() literals; the feature card texts resolve
// at runtime via t(`features.${key}.title`) etc., so list the keys to keep them.
// t("onboarding:features.notes.title") t("onboarding:features.notes.desc")
// t("onboarding:features.tasks.title") t("onboarding:features.tasks.desc")
// t("onboarding:features.calendar.title") t("onboarding:features.calendar.desc")
// t("onboarding:features.search.title") t("onboarding:features.search.desc")
const FEATURES = [
  { key: "notes", Icon: FileText },
  { key: "tasks", Icon: CheckSquare },
  { key: "calendar", Icon: Calendar },
  { key: "search", Icon: Search },
] as const;

// The five coarse feature families of the "choose what you need" step. All off
// by default: skipping the step leaves the vault a clean notes app (the same
// serde defaults an unanswered vault gets). Each pick enables its family's
// specialized flags; the lightweight always-sensible ones are already on.
// t("onboarding:choose.ai.title") t("onboarding:choose.ai.desc")
// t("onboarding:choose.editorExtras.title") t("onboarding:choose.editorExtras.desc")
// t("onboarding:choose.graph.title") t("onboarding:choose.graph.desc")
// t("onboarding:choose.sync.title") t("onboarding:choose.sync.desc")
// t("onboarding:choose.media.title") t("onboarding:choose.media.desc")
const CHOICES = [
  { key: "ai", Icon: Sparkles },
  { key: "editorExtras", Icon: PenLine },
  { key: "graph", Icon: Network },
  { key: "sync", Icon: RefreshCw },
  { key: "media", Icon: Presentation },
] as const;

type ChoiceKey = (typeof CHOICES)[number]["key"];

const GROUP_FLAGS: Record<ChoiceKey, Partial<FeaturePrefs>> = {
  // The AI master switch; its subs keep their defaults (ambient suggestions
  // and the token-costing entity graph stay explicit opt-ins in Settings).
  ai: { ai: true },
  editorExtras: { blockRefs: true, transclusion: true, mermaid: true, math: true },
  graph: { graphView: true, properties: true },
  // Git sync is deliberately absent: enabling it needs the Settings › Sync
  // setup (author identity), so the flag stays with GitPrefs.enabled.
  sync: { p2pSync: true, calendarSync: true, icsSubscriptions: true },
  media: { canvas: true, pdfAnnotate: true, voice: true },
};

export function Onboarding() {
  const { t } = useTranslation("onboarding");
  const dismiss = useUi((s) => s.dismissOnboarding);
  const [step, setStep] = useState<0 | 1>(0);
  const [picks, setPicks] = useState<Record<ChoiceKey, boolean>>({
    ai: false,
    editorExtras: false,
    graph: false,
    sync: false,
    media: false,
  });
  const [busy, setBusy] = useState(false);
  // Which action is in flight, so only its button shows a loading label.
  const [action, setAction] = useState<"tour" | "starter" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Write the picked feature families into the open vault's preferences. A
  // direct read-modify-write against the IPC layer (not the settings store):
  // during the tour path the store may still be reloading for the new vault,
  // and a debounced store persist would race it. No pick → nothing to write,
  // the serde defaults already mean exactly that.
  const persistPicks = async () => {
    const chosen = CHOICES.filter(({ key }) => picks[key]);
    if (chosen.length === 0) return;
    const features = chosen.reduce<Partial<FeaturePrefs>>(
      (acc, { key }) => ({ ...acc, ...GROUP_FLAGS[key] }),
      {},
    );
    const fresh = await api.getPreferences();
    await api.setPreferences({
      ...fresh,
      features: { ...fresh.features, ...features },
    });
    // Refresh the in-memory store so useFeature() flips immediately.
    await useSettings.getState().load();
  };

  const finish = async () => {
    // The buttons are disabled while busy, but Modal fires onClose on Escape
    // unconditionally — without this guard an Escape mid-tour would persist
    // the picks into the vault being abandoned and dismiss the card mid-switch.
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await persistPicks();
      dismiss();
    } catch (e) {
      // Fail loud: surface the problem in-card and let the user retry or
      // clear the toggles (nothing picked closes without writing).
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const startTour = async () => {
    setBusy(true);
    setAction("tour");
    setError(null);
    try {
      const created = await useVault.getState().takeTour();
      // Cancelled the folder picker → stay on the card.
      if (created) {
        // Persist AFTER the switch so the picks land in the new tour vault —
        // the vault the user is actually in from now on.
        await persistPicks();
        dismiss();
      } else {
        setBusy(false);
        setAction(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setAction(null);
    }
  };

  const createStarter = async () => {
    setBusy(true);
    setAction("starter");
    setError(null);
    const path = `${t("starter.filename")}.md`;
    try {
      try {
        await api.createNote(path, { content: t("starter.body") });
      } catch (e) {
        // A note by this name already exists (e.g. onboarding re-triggered after
        // a reset) — just open the existing one rather than failing.
        if (!(e instanceof NovalisError && e.kind === "alreadyExists")) throw e;
      }
      await useVault.getState().refreshTree();
      useUi.getState().openInWorkspace(path);
      await persistPicks();
      dismiss();
    } catch (e) {
      // Fail loud: surface the problem in-card and let the user retry or skip.
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setAction(null);
    }
  };

  return (
    <Modal
      label={t("title")}
      onClose={() => void finish()}
      closeOnOverlayClick={false}
      overlayClassName="z-[60] items-center justify-center p-6"
      panelClassName="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl"
    >
      <div className="relative flex flex-col items-center gap-2 px-6 pt-8 pb-4 text-center">
        <button
          onClick={() => void finish()}
          disabled={busy}
          aria-label={t("close")}
          className="absolute right-3 top-3 rounded-md p-1.5 text-fg-subtle transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
        >
          <X size={16} />
        </button>
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Sparkles size={22} />
        </span>
        <h2 className="text-lg font-semibold text-fg">
          {step === 0 ? t("title") : t("choose.title")}
        </h2>
        <p className="max-w-sm text-sm text-fg-muted">
          {step === 0 ? t("subtitle") : t("choose.subtitle")}
        </p>
      </div>

      {step === 0 ? (
        <div className="grid grid-cols-1 gap-2 overflow-y-auto px-6 py-2 sm:grid-cols-2">
          {FEATURES.map(({ key, Icon }) => (
            <div key={key} className="flex gap-3 rounded-xl border border-border/70 bg-surface-2 p-3">
              <span className="mt-0.5 shrink-0 text-accent">
                <Icon size={18} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">{t(`features.${key}.title`)}</p>
                <p className="mt-0.5 text-xs leading-snug text-fg-subtle">
                  {t(`features.${key}.desc`)}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2 overflow-y-auto px-6 py-2">
          {CHOICES.map(({ key, Icon }) => (
            <div
              key={key}
              className="flex items-center gap-3 rounded-xl border border-border/70 bg-surface-2 p-3"
            >
              <span className="shrink-0 text-accent">
                <Icon size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-fg">{t(`choose.${key}.title`)}</p>
                <p className="mt-0.5 text-xs leading-snug text-fg-subtle">
                  {t(`choose.${key}.desc`)}
                </p>
              </div>
              <Switch
                checked={picks[key]}
                disabled={busy}
                onChange={(v) => setPicks((p) => ({ ...p, [key]: v }))}
                aria-label={t(`choose.${key}.title`)}
              />
            </div>
          ))}
          <p className="px-1 pt-1 text-xs text-fg-subtle">{t("choose.hint")}</p>
        </div>
      )}

      {error && (
        <p className="px-6 pt-1 text-xs text-danger" role="alert">
          {error}
        </p>
      )}

      {step === 0 ? (
        <div className="flex flex-col-reverse gap-2 px-6 pt-3 pb-6 sm:flex-row sm:justify-end">
          <button
            onClick={() => void finish()}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50 sm:mr-auto"
          >
            {t("skip")}
          </button>
          <button
            onClick={() => setStep(1)}
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {t("continue")}
          </button>
        </div>
      ) : (
        <div className="flex flex-col-reverse gap-2 px-6 pt-3 pb-6 sm:flex-row sm:justify-end">
          <button
            onClick={() => void finish()}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50 sm:mr-auto"
          >
            {t("skip")}
          </button>
          <button
            onClick={() => void createStarter()}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
          >
            {action === "starter" ? t("creating") : t("createNote")}
          </button>
          <button
            onClick={() => void startTour()}
            disabled={busy}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {action === "tour" ? t("startingTour") : t("takeTour")}
          </button>
        </div>
      )}
    </Modal>
  );
}
