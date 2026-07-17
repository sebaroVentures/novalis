// @vitest-environment jsdom
//
// A11y contract of the query results view: table rows are keyboard-activable
// (role=button + Enter opens the note, matching the click), and the
// "Save query" flow uses an in-app modal (Tauri's WKWebView returns null from
// window.prompt, silently no-op-ing it) — the modal opens, focuses its input,
// and submitting persists the named query.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import i18n from "../../lib/i18n";

const runQueryMock = vi.hoisted(() => vi.fn());

vi.mock("../../ipc/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ipc/api")>();
  return { ...actual, api: { ...actual.api, runQuery: runQueryMock } };
});

import type { QueryNoteRow, QueryResult } from "../../ipc/api";
import { useSettings } from "../../stores/settingsStore";
import { useUi } from "../../stores/uiStore";
import { QueryView } from "../QueryView";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.clearAllMocks();
  // Seed a stable `savedQueries` array — the store selector returns `?? []`,
  // and a fresh [] each render trips React 19's useSyncExternalStore loop guard.
  useSettings.setState({ prefs: { savedQueries: [] } as never });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const press = (key: string) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });

/** Set a controlled input/textarea's value the way React observes user typing. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function noteRow(path: string, title: string): QueryNoteRow {
  return {
    path,
    title,
    folder: "notes",
    modified: "2026-07-16T00:00:00Z",
    created: "2026-07-16T00:00:00Z",
    tags: [],
    properties: [],
    date: null,
  };
}

const tableResult = (rows: QueryNoteRow[]): QueryResult => ({
  notes: rows,
  tasks: [],
  view: "table",
  propertyKeys: [],
  hasDates: false,
});

describe("QueryView keyboard + save-query modal", () => {
  it("activates a table row with Enter, opening the note (keyboard parity for click)", async () => {
    const openSpy = vi.fn();
    useUi.setState({ openNoteFrom: openSpy });
    (runQueryMock as Mock).mockResolvedValue(tableResult([noteRow("notes/a.md", "Alpha")]));

    await act(async () => root.render(<QueryView />));

    const queryInput = container.querySelector("input")!;
    setValue(queryInput, "type:note");
    await act(async () => {
      queryInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    // Let the mocked runQuery promise resolve and the table render.
    await act(async () => {});

    const row = container.querySelector<HTMLTableRowElement>('tr[role="button"]');
    expect(row).not.toBeNull();
    expect(row!.tabIndex).toBe(0);

    act(() => row!.focus());
    await press("Enter");
    expect(openSpy).toHaveBeenCalledWith("notes/a.md", "query");
  });

  it("opens the save-query modal, focuses its input, and submits the name", async () => {
    const saveSpy = vi.fn();
    useSettings.setState({ setSavedQueries: saveSpy });

    await act(async () => root.render(<QueryView />));

    const queryInput = container.querySelector("input")!;
    setValue(queryInput, "tag:urgent");

    const saveBtn = container.querySelector<HTMLButtonElement>(
      `button[title="${i18n.t("query.save", { ns: "common" })}"]`,
    )!;
    expect(saveBtn).not.toBeNull();
    await act(async () => saveBtn.click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const nameInput = dialog!.querySelector<HTMLInputElement>("input")!;
    expect(document.activeElement).toBe(nameInput);

    setValue(nameInput, "My urgent query");
    await press("Enter");

    expect(saveSpy).toHaveBeenCalledWith([{ name: "My urgent query", query: "tag:urgent" }]);
    // Modal closed after submit.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
