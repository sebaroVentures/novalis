// Extraction config for i18next-parser. Scans t()/<Trans> usages and keeps the
// English catalogs in sync. CI runs `i18next --fail-on-update` to guarantee no
// key used in code is missing from (or orphaned in) the catalog.
//
// The parser owns the catalog file format (sorted keys, 2-space indent); new
// keys get an empty value so the catalog test (no-empty-values) flags anything
// not yet translated. Fill in the English text by hand after extracting.
export default {
  locales: ["en"],
  defaultNamespace: "common",
  namespaceSeparator: ":",
  keySeparator: ".",
  input: ["src/**/*.{ts,tsx}", "!src/ipc/bindings.ts", "!src/**/*.d.ts"],
  output: "src/locales/$LOCALE/$NAMESPACE.json",
  sort: true,
  keepRemoved: false,
  createOldCatalogs: false,
  indentation: 2,
  defaultValue: "",
};
