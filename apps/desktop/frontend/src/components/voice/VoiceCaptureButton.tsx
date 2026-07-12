import { useEffect } from "react";

import { Loader2, Mic, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useVoice } from "../../stores/voiceStore";

/** Store-mounted floating capture widget (feature W4.3): a mic button that
 *  records a meeting, transcribes it on-device, writes a transcript note, and
 *  opens the existing task-extraction review. Renders nothing on platforms
 *  without native capture (e.g. mobile). */
export function VoiceCaptureButton() {
  const { t } = useTranslation("ai");
  const available = useVoice((s) => s.available);
  const status = useVoice((s) => s.status);
  const error = useVoice((s) => s.error);
  const checkAvailability = useVoice((s) => s.checkAvailability);

  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  if (!available) return null;

  const recording = status === "recording";
  const transcribing = status === "transcribing";

  return (
    <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2">
      {error && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-950/80 px-3 py-1.5 text-xs text-danger shadow-lg">
          <span className="min-w-0 break-words">{error}</span>
          <button
            type="button"
            aria-label={t("voice.cancel")}
            onClick={() => useVoice.getState().clearError()}
            className="shrink-0 rounded p-0.5 text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={13} />
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        {recording ? (
          <>
            <button
              type="button"
              onClick={() => void useVoice.getState().stopAndProcess()}
              className="flex items-center gap-2 rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-fg shadow-lg transition hover:opacity-90"
            >
              <span className="relative flex h-2.5 w-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
              </span>
              <Square size={14} />
              {t("voice.stop")}
            </button>
            <button
              type="button"
              aria-label={t("voice.cancel")}
              onClick={() => void useVoice.getState().cancel()}
              className="rounded-full border border-border bg-surface p-2 text-fg-muted shadow-lg transition-colors hover:bg-hover hover:text-fg"
            >
              <X size={16} />
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={transcribing}
            title={t("voice.tooltip")}
            onClick={() => void useVoice.getState().start()}
            className="flex items-center gap-2 rounded-full border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-fg shadow-lg transition hover:bg-hover disabled:cursor-not-allowed disabled:opacity-70"
          >
            {transcribing ? (
              <>
                <Loader2 size={16} className="animate-spin text-accent" />
                {t("voice.transcribing")}
              </>
            ) : (
              <>
                <Mic size={16} className="text-accent" />
                {t("voice.record")}
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
