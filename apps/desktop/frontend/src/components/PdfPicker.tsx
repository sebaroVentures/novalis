import { useEffect, useMemo, useRef, useState } from "react";

import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";

import { api, type PdfSummary } from "../ipc/api";
import { fuzzyRank } from "../lib/fuzzy";
import { usePdf } from "../stores/pdfStore";
import { Modal } from "./ui/Modal";

/** "Open PDF" picker (feature W4.2): a fuzzy list of the vault's PDFs, opened
 *  from the command palette. Picking one mounts the viewer overlay. Reuses the
 *  command-palette modal shell. */
export function PdfPicker() {
  const { t } = useTranslation("pdf");
  const open = usePdf((s) => s.pickerOpen);
  const close = usePdf((s) => s.closePicker);
  const openPdf = usePdf((s) => s.open);

  const [pdfs, setPdfs] = useState<PdfSummary[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    void api
      .listPdfs()
      .then(setPdfs)
      .catch(() => setPdfs([]));
  }, [open]);

  const filtered = useMemo(
    () => fuzzyRank(pdfs, query.trim(), (p) => `${p.name} ${p.path}`),
    [pdfs, query],
  );

  if (!open) return null;

  const pick = (p: PdfSummary) => {
    openPdf(p.path);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = filtered[selected];
      if (p) pick(p);
    }
  };

  return (
    <Modal
      label={t("picker.title")}
      onClose={close}
      initialFocusRef={inputRef}
      overlayClassName="z-50 items-start justify-center pt-28"
      panelClassName="w-full max-w-lg overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
    >
      <div className="px-4 pt-3 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
        {t("picker.title")}
      </div>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(0);
        }}
        placeholder={t("picker.placeholder")}
        className="w-full bg-transparent px-4 py-3 text-fg outline-none placeholder:text-fg-faint"
        onKeyDown={onKeyDown}
      />
      <ul className="max-h-80 overflow-y-auto border-t border-border">
        {filtered.length === 0 && (
          <li className="px-4 py-3 text-sm text-fg-faint">{t("picker.empty")}</li>
        )}
        {filtered.map((p, i) => (
          <li key={p.path}>
            <button
              onMouseMove={() => setSelected(i)}
              onClick={() => pick(p)}
              className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left ${
                i === selected ? "bg-active" : "hover:bg-hover"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileText size={15} className="shrink-0 text-fg-subtle" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm text-fg">{p.name}</span>
                  {p.folder && (
                    <span className="truncate text-[11px] text-fg-faint">{p.folder}</span>
                  )}
                </span>
              </span>
              {p.highlightCount > 0 && (
                <span className="shrink-0 rounded bg-active px-1.5 text-[10px] font-medium tabular-nums text-fg-muted">
                  {t("picker.count", { count: p.highlightCount })}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
