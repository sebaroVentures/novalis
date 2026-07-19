import { useEffect, useState } from "react";

import { Loader2, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useFeature } from "../../lib/features";
import { useVoice } from "../../stores/voiceStore";

/** Two-digit zero-pad. */
const pad = (n: number) => String(n).padStart(2, "0");
/** Elapsed seconds → mm:ss. */
const mmss = (secs: number) => `${pad(Math.floor(secs / 60))}:${pad(secs % 60)}`;

/** Store-mounted meeting-capture status strip (feature W4.3). Always mounted so
 *  it can probe capture availability once, but renders a full-width docked bar —
 *  a sibling of CloudHint / the conflict banner, so it reflows the view instead
 *  of floating over it — ONLY while a capture is active (recording /
 *  transcribing / error). The idle *start* trigger lives in the ActivityRail and
 *  the command palette, so nothing sits over the editor when nothing is
 *  recording. Renders nothing where capture is unavailable (e.g. mobile). */
export function RecordingDock() {
  const { t } = useTranslation("ai");
  const status = useVoice((s) => s.status);
  const error = useVoice((s) => s.error);
  const startedAt = useVoice((s) => s.recordingStartedAt);
  const checkAvailability = useVoice((s) => s.checkAvailability);
  const voiceOn = useFeature("voice");

  useEffect(() => {
    void checkAvailability();
  }, [checkAvailability]);

  // Live mm:ss ticker — runs only while recording. Resets to 0 the moment
  // recording ends (this component stays mounted, so the state would otherwise
  // survive and flash the previous take's duration for one frame at the start of
  // the next one). Seeds immediately so the strip reads 00:00 as recording opens.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (status !== "recording" || startedAt == null) {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [status, startedAt]);

  // Feature off: stay mounted (the availability probe above is what feeds the
  // rail mic + palette entry) but show no UI — EXCEPT while a capture is in
  // flight or finishing: these buttons are the only stop/cancel affordance, so
  // hiding them mid-recording would strand a live microphone capture.
  if (!voiceOn && status === "idle") return null;

  // Nothing to show while idle (and no lingering error): keep the editor clear.
  if (status === "idle" && !error) return null;

  // A failed step leaves status "error" with a message — a danger-tinted strip
  // with a dismiss that resets the store back to idle (clearError).
  if (status === "error" && error) {
    return (
      <div className="flex items-center gap-3 border-b border-red-500/40 bg-red-950/40 px-4 py-1.5 text-xs text-danger">
        <span className="min-w-0 flex-1 break-words">{error}</span>
        <button
          type="button"
          aria-label={t("voice.cancel")}
          onClick={() => useVoice.getState().clearError()}
          className="shrink-0 rounded p-0.5 text-danger transition-colors hover:bg-active"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface-2 px-4 py-1.5 text-xs text-fg-muted">
      {status === "recording" ? (
        <>
          <span className="relative flex h-2.5 w-2.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
          </span>
          <span className="font-medium text-danger">{t("voice.recording")}</span>
          <span className="tabular-nums text-danger">{mmss(elapsed)}</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void useVoice.getState().stopAndProcess()}
              className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 font-medium text-accent-fg transition hover:opacity-90"
            >
              <Square size={12} />
              {t("voice.stop")}
            </button>
            <button
              type="button"
              aria-label={t("voice.cancel")}
              onClick={() => void useVoice.getState().cancel()}
              className="rounded-md border border-border p-1 text-fg-muted transition-colors hover:bg-active hover:text-fg"
            >
              <X size={14} />
            </button>
          </div>
        </>
      ) : (
        // transcribing
        <>
          <Loader2 size={14} className="shrink-0 animate-spin text-accent" />
          <span>{t("voice.transcribing")}</span>
        </>
      )}
    </div>
  );
}
