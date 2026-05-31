// Type-safe i18next keys: the English catalogs are the source of truth, so any
// t("ns:key") referencing a key absent from en/*.json is a compile error.
import "i18next";

import calendar from "../locales/en/calendar.json";
import common from "../locales/en/common.json";
import editor from "../locales/en/editor.json";
import settings from "../locales/en/settings.json";
import sidebar from "../locales/en/sidebar.json";
import tasks from "../locales/en/tasks.json";
import vault from "../locales/en/vault.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof common;
      settings: typeof settings;
      sidebar: typeof sidebar;
      calendar: typeof calendar;
      tasks: typeof tasks;
      editor: typeof editor;
      vault: typeof vault;
    };
  }
}
