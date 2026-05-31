// Runtime wiring check: proves the i18next instance initializes, resolves keys
// across namespaces, and interpolates — complementing the structural catalog
// test (which only inspects the JSON files).
import { describe, expect, it } from "vitest";

import { displayError } from "../errors";
import i18n from "../i18n";

describe("i18n runtime", () => {
  // The startup language is device-local and falls back to the OS locale, so the
  // ambient default varies by machine. Pin the language per call via the `lng`
  // option to keep these assertions deterministic everywhere.
  it("resolves English keys across namespaces", () => {
    expect(i18n.t("common:save", { lng: "en" })).toBe("Save");
    expect(i18n.t("settings:nav.general", { lng: "en" })).toBe("General");
    expect(i18n.t("sidebar:menu.delete", { lng: "en" })).toBe("Delete");
    expect(i18n.t("calendar:today", { lng: "en" })).toBe("Today");
    expect(i18n.t("tasks:agenda.overdue", { lng: "en" })).toBe("Overdue");
    expect(i18n.t("editor:placeholder", { lng: "en" })).toBe("Start writing…");
    expect(i18n.t("vault:openVault", { lng: "en" })).toBe("Open a vault…");
    expect(i18n.t("common:errorPrefix", { lng: "en" })).toBe("Error: ");
  });

  it("interpolates values into messages", () => {
    expect(i18n.t("sidebar:confirm.trashNote", { title: "My Note", lng: "en" })).toBe(
      'Move "My Note" to trash?',
    );
    expect(i18n.t("settings:calendar.connectProvider", { provider: "google", lng: "en" })).toBe(
      "Connect google",
    );
  });

  it("resolves and interpolates the German locale", () => {
    expect(i18n.t("common:save", { lng: "de" })).toBe("Speichern");
    expect(i18n.t("common:views.notes", { lng: "de" })).toBe("Notizen");
    expect(i18n.t("calendar:today", { lng: "de" })).toBe("Heute");
    expect(i18n.t("vault:openVault", { lng: "de" })).toBe("Vault öffnen…");
    expect(i18n.t("sidebar:confirm.trashNote", { title: "Meine Notiz", lng: "de" })).toBe(
      "„Meine Notiz“ in den Papierkorb verschieben?",
    );
    expect(i18n.t("common:errorPrefix", { lng: "de" })).toBe("Fehlermeldung: ");
  });

  it("resolves and interpolates the French locale", () => {
    expect(i18n.t("common:save", { lng: "fr" })).toBe("Enregistrer");
    expect(i18n.t("common:views.tasks", { lng: "fr" })).toBe("Tâches");
    expect(i18n.t("calendar:today", { lng: "fr" })).toBe("Aujourd'hui");
    expect(i18n.t("vault:openVault", { lng: "fr" })).toBe("Ouvrir un Vault…");
    expect(i18n.t("common:errorPrefix", { lng: "fr" })).toBe("Erreur : ");
    expect(i18n.t("sidebar:confirm.trashNote", { title: "Ma note", lng: "fr" })).toBe(
      "Mettre « Ma note » à la corbeille ?",
    );
  });

  it("resolves and interpolates the Spanish locale", () => {
    expect(i18n.t("common:save", { lng: "es" })).toBe("Guardar");
    expect(i18n.t("common:views.tasks", { lng: "es" })).toBe("Tareas");
    expect(i18n.t("calendar:today", { lng: "es" })).toBe("Hoy");
    expect(i18n.t("vault:openVault", { lng: "es" })).toBe("Abrir un Vault…");
    expect(i18n.t("common:errorPrefix", { lng: "es" })).toBe("Error: ");
    expect(i18n.t("sidebar:confirm.trashNote", { title: "Mi nota", lng: "es" })).toBe(
      "¿Mover «Mi nota» a la papelera?",
    );
  });

  it("prefixes a raw backend error with the localized label (displayError)", async () => {
    // displayError uses the active language; the explicit-lng tests above are
    // unaffected since they pass { lng } per call.
    await i18n.changeLanguage("de");
    expect(displayError(new Error("not found: x.md"))).toBe("Fehlermeldung: not found: x.md");
    await i18n.changeLanguage("en");
    expect(displayError("teapot")).toBe("Error: teapot");
  });
});
