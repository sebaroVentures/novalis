import { useEffect, useRef, useState } from "react";

import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useSettings } from "../../stores/settingsStore";
import { Modal } from "../ui/Modal";
import { SettingsNav, useCategoryLabels, type CategoryId } from "./SettingsNav";
import { AboutPanel } from "./panels/AboutPanel";
import { AiPanel } from "./panels/AiPanel";
import { AppearancePanel } from "./panels/AppearancePanel";
import { CalendarPanel } from "./panels/CalendarPanel";
import { EditorPanel } from "./panels/EditorPanel";
import { GeneralPanel } from "./panels/GeneralPanel";
import { ImportPanel } from "./panels/ImportPanel";
import { KeybindingsPanel } from "./panels/KeybindingsPanel";
import { LanguagePanel } from "./panels/LanguagePanel";
import { NavigationPanel } from "./panels/NavigationPanel";
import { PluginsPanel } from "./panels/PluginsPanel";
import { SyncPanel } from "./panels/SyncPanel";
import { TasksPanel } from "./panels/TasksPanel";
import { TemplatesPanel } from "./panels/TemplatesPanel";
import { VaultPanel } from "./panels/VaultPanel";

export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation("settings");
  const labels = useCategoryLabels();
  const [active, setActive] = useState<CategoryId>("general");
  // `render` keeps the dialog mounted through its exit animation; `show` drives
  // the enter/exit transition classes.
  const [render, setRender] = useState(open);
  const [show, setShow] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);

  useEffect(() => {
    if (open) {
      closingRef.current = false;
      void useSettings.getState().load();
      setRender(true);
      const id = requestAnimationFrame(() => setShow(true));
      return () => cancelAnimationFrame(id);
    }
    setShow(false);
    const t = setTimeout(() => setRender(false), 180);
    return () => clearTimeout(t);
  }, [open]);

  const close = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    // Blur the focused field first so commit-on-blur edits (e.g. the font-size
    // draft in AppearancePanel) land in the store before we flush — covers Esc,
    // which otherwise wouldn't fire blur.
    (document.activeElement as HTMLElement | null)?.blur();
    // Persist any pending debounced edits before unmounting the dialog.
    await useSettings.getState().flush();
    onClose();
  };

  if (!render) return null;

  const title = labels[active];

  return (
    <Modal
      label={t("modal.title")}
      onClose={() => void close()}
      initialFocusRef={panelRef}
      overlayClassName={`z-50 items-center justify-center p-4 backdrop-blur-sm transition-opacity duration-150 ${
        show ? "opacity-100" : "opacity-0"
      }`}
      panelClassName={`flex h-[80vh] max-h-[640px] w-full max-w-3xl overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl transition-all duration-200 ease-out ${
        show ? "scale-100 opacity-100" : "scale-95 opacity-0"
      }`}
    >
      <SettingsNav active={active} onSelect={setActive} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-border px-6 py-3">
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          <button
            onClick={() => void close()}
            aria-label={t("modal.close")}
            className="rounded-md p-1 text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>
        <div
          key={active}
          ref={panelRef}
          tabIndex={-1}
          className="nv-panel-enter min-w-0 flex-1 overflow-y-auto p-6 outline-none"
        >
          {active === "general" && <GeneralPanel />}
          {active === "vault" && <VaultPanel onSwitched={() => void close()} />}
          {active === "sync" && <SyncPanel />}
          {active === "appearance" && <AppearancePanel />}
          {active === "navigation" && <NavigationPanel />}
          {active === "language" && <LanguagePanel />}
          {active === "editor" && <EditorPanel />}
          {active === "tasks" && <TasksPanel />}
          {active === "calendar" && <CalendarPanel />}
          {active === "keybindings" && <KeybindingsPanel />}
          {active === "templates" && <TemplatesPanel />}
          {active === "import" && <ImportPanel />}
          {active === "plugins" && <PluginsPanel />}
          {active === "ai" && <AiPanel />}
          {active === "about" && <AboutPanel />}
        </div>
      </div>
    </Modal>
  );
}
