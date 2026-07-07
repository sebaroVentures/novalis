import { useRef } from "react";

import { useTranslation } from "react-i18next";

import { Modal } from "./Modal";

/** A small confirmation dialog. Labels are passed in (already localized) so the
 *  primitive stays content-agnostic; the Cancel label comes from `common`.
 *  Focus starts on the confirm button, so Enter confirms and Escape cancels. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("common");
  const confirmRef = useRef<HTMLButtonElement>(null);
  if (!open) return null;
  return (
    <Modal
      label={title}
      onClose={onCancel}
      initialFocusRef={confirmRef}
      overlayClassName="z-[60] items-center justify-center p-6"
      panelClassName="w-full max-w-sm overflow-hidden rounded-xl border border-border-strong bg-surface p-5 shadow-2xl"
    >
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {body && <p className="mt-2 text-xs leading-relaxed text-fg-muted">{body}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          {t("cancel")}
        </button>
        <button
          ref={confirmRef}
          onClick={onConfirm}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            danger
              ? "bg-danger text-white hover:opacity-90"
              : "bg-accent text-accent-fg hover:opacity-90"
          }`}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
