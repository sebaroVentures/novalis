import { useEffect, useState } from "react";

import { RotateCcw, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatStamp } from "../lib/datetime";
import { api, type TrashItem } from "../ipc/api";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";
import { ConfirmDialog } from "./ui/ConfirmDialog";

type Pending = { kind: "item"; item: TrashItem } | { kind: "empty" } | null;

export function TrashModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation(["trash", "common"]);
  const [items, setItems] = useState<TrashItem[]>([]);
  const [confirm, setConfirm] = useState<Pending>(null);
  const refreshTree = useVault((s) => s.refreshTree);
  const openInWorkspace = useUi((s) => s.openInWorkspace);

  const load = () => void api.listTrash().then(setItems).catch(() => setItems([]));
  useEffect(() => {
    if (open) load();
  }, [open]);

  if (!open) return null;

  const basename = (p: string) => p.split("/").pop() ?? p;
  const folderOf = (p: string) => {
    const i = p.lastIndexOf("/");
    return i === -1 ? "" : p.slice(0, i);
  };

  const restore = async (item: TrashItem) => {
    try {
      const path = await api.restoreTrash(item.id);
      load();
      await refreshTree();
      if (path.endsWith(".md")) openInWorkspace(path);
    } catch {
      /* surfaced via the global error banner */
    }
  };

  const runConfirm = async () => {
    if (!confirm) return;
    if (confirm.kind === "item") await api.deleteTrashItem(confirm.item.id).catch(() => {});
    else await api.emptyTrash().catch(() => {});
    setConfirm(null);
    load();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Trash2 size={16} className="text-fg-muted" />
            {t("title")}
          </h2>
          <div className="flex items-center gap-1">
            {items.length > 0 && (
              <button
                onClick={() => setConfirm({ kind: "empty" })}
                className="rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-red-500/10 hover:text-danger"
              >
                {t("emptyTrash")}
              </button>
            )}
            <button
              onClick={onClose}
              aria-label={t("common:cancel")}
              className="rounded-md p-1 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <X size={16} />
            </button>
          </div>
        </header>

        {items.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-fg-faint">{t("empty")}</div>
        ) : (
          <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
            {items.map((item) => (
              <li key={item.id} className="flex items-center gap-3 px-5 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-fg">
                    {basename(item.originalPath).replace(/\.md$/, "")}
                  </div>
                  <div className="truncate text-xs text-fg-faint">
                    {folderOf(item.originalPath) || "/"} · {formatStamp(item.trashedAt)}
                  </div>
                </div>
                <button
                  onClick={() => void restore(item)}
                  title={t("restore")}
                  className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-active hover:text-fg"
                >
                  <RotateCcw size={15} />
                </button>
                <button
                  onClick={() => setConfirm({ kind: "item", item })}
                  title={t("deletePermanently")}
                  className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-red-500/10 hover:text-danger"
                >
                  <Trash2 size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        danger
        title={confirm?.kind === "empty" ? t("emptyConfirmTitle") : t("deleteConfirmTitle")}
        body={
          confirm?.kind === "empty"
            ? t("emptyConfirmBody")
            : confirm?.kind === "item"
              ? t("deleteConfirmBody", {
                  name: basename(confirm.item.originalPath).replace(/\.md$/, ""),
                })
              : undefined
        }
        confirmLabel={t("common:delete")}
        onConfirm={() => void runConfirm()}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
