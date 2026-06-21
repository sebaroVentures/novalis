import { useEffect } from "react";

import { events } from "../ipc/api";
import { useAi } from "../stores/aiStore";

/** Route backend AI streaming events into the active run in the AI store. */
export function useAiEvents() {
  useEffect(() => {
    const unlisten = [
      events.aiStreamChunk.listen((e) =>
        useAi.getState().appendChunk(e.payload.requestId, e.payload.delta),
      ),
      events.aiStreamDone.listen((e) => useAi.getState().finishRun(e.payload.requestId)),
      events.aiStreamError.listen((e) =>
        useAi.getState().failRun(e.payload.requestId, e.payload.message),
      ),
    ];
    return () => {
      for (const p of unlisten) void p.then((off) => off());
    };
  }, []);
}
