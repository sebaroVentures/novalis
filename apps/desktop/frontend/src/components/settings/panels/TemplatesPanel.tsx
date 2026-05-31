import { useEffect, useState } from "react";

import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, type NoteTemplate } from "../../../ipc/api";
import { SettingsSection, TextField } from "../../ui";

export function TemplatesPanel() {
  const { t } = useTranslation("settings");
  const [templates, setTemplates] = useState<NoteTemplate[]>([]);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");

  const reload = () => void api.listTemplates().then(setTemplates).catch(() => {});
  useEffect(() => {
    reload();
  }, []);

  const create = () => {
    if (!name.trim()) return;
    void api
      .createTemplate(name.trim(), content)
      .then(() => {
        setName("");
        setContent("");
        reload();
      })
      .catch(() => {});
  };
  const remove = (id: string) => void api.deleteTemplate(id).then(reload).catch(() => {});

  return (
    <SettingsSection title={t("templates.section")} description={t("templates.desc")}>
      <div className="space-y-1">
        {templates.length === 0 && (
          <p className="text-xs text-fg-faint">{t("templates.empty")}</p>
        )}
        {templates.map((tpl) => (
          <div key={tpl.id} className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate text-fg-muted">{tpl.name}</span>
            <button
              onClick={() => remove(tpl.id)}
              aria-label={t("templates.deleteAria")}
              className="rounded-md p-1.5 text-fg-subtle transition-colors hover:bg-hover hover:text-danger"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 space-y-2 rounded-xl bg-app/50 p-3">
        <TextField
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("templates.namePlaceholder")}
          className="w-full"
        />
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t("templates.contentPlaceholder")}
          rows={4}
          className="w-full rounded-lg bg-surface-2 px-2.5 py-1.5 font-mono text-xs text-fg outline-none ring-1 ring-transparent transition placeholder:text-fg-faint focus:ring-accent/50"
        />
        <button
          onClick={create}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90"
        >
          {t("templates.add")}
        </button>
      </div>
    </SettingsSection>
  );
}
