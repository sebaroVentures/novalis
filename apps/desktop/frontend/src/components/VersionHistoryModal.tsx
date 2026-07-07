import { useEffect, useState } from "react";

import { History, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatDateTime } from "../lib/datetime";
import { api, type DiffLine, type VersionMeta } from "../ipc/api";
import { useVault } from "../stores/vaultStore";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Modal } from "./ui/Modal";

export function VersionHistoryModal({
  open,
  path,
  onClose,
}: {
  open: boolean;
  path: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation(["versions", "common"]);
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [selected, setSelected] = useState<VersionMeta | null>(null);
  const [diff, setDiff] = useState<DiffLine[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reloadActive = useVault((s) => s.reloadActive);
  const reportError = useVault((s) => s.reportError);

  const load = (p: string) =>
    void api
      .listVersions(p)
      .then((v) => {
        setVersions(v);
        setSelected(v[0] ?? null);
      })
      .catch(() => setVersions([]));

  useEffect(() => {
    if (open && path) load(path);
  }, [open, path]);

  useEffect(() => {
    if (!path || !selected) {
      setDiff([]);
      return;
    }
    let cancelled = false;
    void api
      .diffVersion(path, selected.id)
      .then((d) => !cancelled && setDiff(d))
      .catch(() => !cancelled && setDiff([]));
    return () => {
      cancelled = true;
    };
  }, [path, selected]);

  if (!open) return null;

  const restore = async () => {
    if (!path || !selected) return;
    setConfirmOpen(false);
    try {
      await api.restoreVersion(path, selected.id);
      await reloadActive();
      load(path); // a restore snapshots the replaced content, so the list grows
    } catch (e) {
      reportError(e);
    }
  };

  return (
    <Modal
      label={t("title")}
      onClose={onClose}
      overlayClassName="z-50 items-center justify-center p-6"
      panelClassName="flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
          <History size={16} className="text-fg-muted" />
          {t("title")}
        </h2>
        <button
          onClick={onClose}
          aria-label={t("common:cancel")}
          className="rounded-md p-1 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <X size={16} />
        </button>
      </header>

      {versions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-fg-faint">
          {t("empty")}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul className="w-56 shrink-0 overflow-y-auto border-r border-border">
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  onClick={() => setSelected(v)}
                  className={`block w-full px-4 py-2 text-left text-xs transition-colors ${
                    selected?.id === v.id ? "bg-accent-soft text-fg" : "text-fg-muted hover:bg-hover"
                  }`}
                >
                  {formatDateTime(v.createdAt)}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex min-h-0 flex-1 flex-col">
            {diff.some((l) => l.kind !== "equal") ? (
              <div className="min-h-0 flex-1 overflow-auto px-3 py-3 font-mono text-[11px] leading-relaxed">
                {diff.map((line, i) => (
                  <div
                    key={i}
                    className={`whitespace-pre-wrap ${
                      line.kind === "insert"
                        ? "bg-diff-add-soft text-diff-add"
                        : line.kind === "delete"
                          ? "bg-diff-del-soft text-diff-del"
                          : "text-fg-muted"
                    }`}
                  >
                    <span className="select-none text-fg-faint">
                      {line.kind === "insert" ? "+ " : line.kind === "delete" ? "- " : "  "}
                    </span>
                    {line.content || " "}
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-xs text-fg-faint">
                {t("identical")}
              </div>
            )}
            <div className="flex justify-end border-t border-border px-4 py-3">
              <button
                disabled={!selected}
                onClick={() => setConfirmOpen(true)}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:opacity-90 disabled:opacity-50"
              >
                {t("restore")}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={t("restoreConfirmTitle")}
        body={t("restoreConfirmBody")}
        confirmLabel={t("restore")}
        onConfirm={() => void restore()}
        onCancel={() => setConfirmOpen(false)}
      />
    </Modal>
  );
}
