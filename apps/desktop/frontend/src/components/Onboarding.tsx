import { useState } from "react";

import { Calendar, CheckSquare, FileText, Search, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, NovalisError } from "../ipc/api";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";
import { Modal } from "./ui";

// First-run welcome. Shown once per device (gated on uiStore.onboardingDone in
// App), it gives a one-screen tour of the four pillars and offers to seed a
// starter note so the vault isn't a blank canvas. Skippable via the button, the
// X, or Escape — every exit path marks onboarding done.

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

export function Onboarding() {
  const { t } = useTranslation("onboarding");
  const dismiss = useUi((s) => s.dismissOnboarding);
  const [busy, setBusy] = useState(false);
  // Which action is in flight, so only its button shows a loading label.
  const [action, setAction] = useState<"tour" | "starter" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const finish = () => dismiss();

  const startTour = async () => {
    setBusy(true);
    setAction("tour");
    setError(null);
    try {
      const created = await useVault.getState().takeTour();
      // Cancelled the folder picker → stay on the welcome card.
      if (created) dismiss();
      else {
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
      onClose={finish}
      closeOnOverlayClick={false}
      overlayClassName="z-[60] items-center justify-center p-6"
      panelClassName="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl"
    >
      <div className="relative flex flex-col items-center gap-2 px-6 pt-8 pb-4 text-center">
        <button
          onClick={finish}
          aria-label={t("close")}
          className="absolute right-3 top-3 rounded-md p-1.5 text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <X size={16} />
        </button>
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Sparkles size={22} />
        </span>
        <h2 className="text-lg font-semibold text-fg">{t("title")}</h2>
        <p className="max-w-sm text-sm text-fg-muted">{t("subtitle")}</p>
      </div>

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

      {error && (
        <p className="px-6 pt-1 text-xs text-danger" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 px-6 pt-3 pb-6 sm:flex-row sm:justify-end">
        <button
          onClick={finish}
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
    </Modal>
  );
}
