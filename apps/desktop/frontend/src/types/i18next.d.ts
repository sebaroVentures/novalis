// Type-safe i18next keys: the English catalogs are the source of truth, so any
// t("ns:key") referencing a key absent from en/*.json is a compile error.
import "i18next";

import ai from "../locales/en/ai.json";
import calendar from "../locales/en/calendar.json";
import common from "../locales/en/common.json";
import conflict from "../locales/en/conflict.json";
import editor from "../locales/en/editor.json";
// `help` loads lazily at runtime (src/help/loadHelp.ts) — this import is
// type-only (d.ts), so the catalog stays out of the eager bundle.
import help from "../locales/en/help.json";
import links from "../locales/en/links.json";
import onboarding from "../locales/en/onboarding.json";
import pdf from "../locales/en/pdf.json";
import settings from "../locales/en/settings.json";
import sidebar from "../locales/en/sidebar.json";
import tasks from "../locales/en/tasks.json";
import today from "../locales/en/today.json";
import trash from "../locales/en/trash.json";
import vault from "../locales/en/vault.json";
import versions from "../locales/en/versions.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof common;
      ai: typeof ai;
      settings: typeof settings;
      onboarding: typeof onboarding;
      sidebar: typeof sidebar;
      calendar: typeof calendar;
      tasks: typeof tasks;
      today: typeof today;
      editor: typeof editor;
      vault: typeof vault;
      trash: typeof trash;
      conflict: typeof conflict;
      versions: typeof versions;
      links: typeof links;
      pdf: typeof pdf;
      help: typeof help;
    };
  }
}
