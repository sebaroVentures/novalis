# Translations

This is the single source of UI strings for the desktop frontend. English
(`en/`) is the canonical catalog; every other locale mirrors its keys.

## Layout

One JSON file per feature domain (namespace):

| Namespace        | Covers                                                        |
| ---------------- | ------------------------------------------------------------- |
| `common.json`    | shared verbs (Save/Cancel/Delete…), view & task-mode names    |
| `settings.json`  | the Settings dialog (nav + all panels)                        |
| `sidebar.json`   | the notes sidebar, context menus, confirmations               |
| `calendar.json`  | the calendar view + event modal                               |
| `tasks.json`     | the tasks view (list/board/agenda)                            |
| `editor.json`    | editor chrome + the labels passed to `@novalis/editor`        |
| `vault.json`     | vault gate, cloud hint, command palette, search               |

Keys are nested and referenced as `t("namespace:dotted.key")` (or bare keys when
the component binds the namespace via `useTranslation("namespace")`).

## How strings get here

`t()` / `<Trans>` calls in `src/**` are the source of truth. The extractor scans
them and writes/prunes keys:

```
pnpm i18n:extract     # add new keys (empty value) / remove orphaned ones
pnpm i18n:check       # CI gate: fails if the catalog is out of sync with code
```

New keys land with an empty value — fill in the English text by hand. The
catalog test (`pnpm test`) fails on any empty value, so nothing ships
untranslated.

## Conventions

- **Interpolation:** `"Move \"{{title}}\" to trash?"` — pass values via
  `t(key, { title })`. Escaping is off, so `{{var}}` renders raw.
- **Rich text:** use `<Trans>` for embedded markup; placeholders are `<1>…</1>`
  (indexed) or named via the `components` prop.
- **Counts/plurals:** always pass `count` (`t(key, { count })`) and define
  `key_one` / `key_other` — never concatenate, so other locales' plural rules
  apply.
- **Don't translate:** file paths, the task `@annotation` syntax, format names
  (HTML, .ics), product/brand names, or logic enum tokens (e.g. `"notes"`,
  `"backlog"`) — those are keys, not display text; their labels live here.
- **Dates/times/weekdays** are not strings here — they're formatted by
  `lib/datetime.ts` via `Intl` against the active language.

## Adding a locale (e.g. Italian)

German (`de/`), French (`fr/`), and Spanish (`es/`) already ship — use them as
worked examples.

1. `cp -r en it` and translate every value in `it/*.json` (keep the keys).
2. Add `"it"` to `LanguageCode` and `SUPPORTED_LANGUAGES` in `lib/language.ts`.
3. Import the `it/*.json` and add an `it` entry to `resources` in `lib/i18n.ts`.
   (`types/i18next.d.ts` stays `en`-only — English is the typing source of truth.)
4. Add the locale to `LOCALES` in `locales/__tests__/catalogs.test.ts` so its
   parity is enforced: same keys as `en`, identical `{{vars}}` and markup, and no
   empty values. The test fails if anything is left untranslated. Add a runtime
   resolution check in `lib/__tests__/i18n.test.ts` too.
5. The picker (Settings → Language) lists it automatically.

## Pseudo-locale (dev QA)

In dev builds the picker offers **Pseudo (en-XA)** — a generated copy of English
where every string is accénted and `⟦bracketed⟧`. Switch to it and scan the
app: any plain, un-bracketed text is a string that escaped i18n. Fix it (wrap in
`t()`), then re-scan.
