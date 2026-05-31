import { useTranslation } from "react-i18next";

export function PanelLoading() {
  const { t } = useTranslation();
  return <p className="text-sm text-fg-subtle">{t("loading")}</p>;
}
