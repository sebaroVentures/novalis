import { useEffect } from "react";

import { events } from "../ipc/api";
import { useVault } from "../stores/vaultStore";

/** Subscribe to backend vault events and keep the UI in sync. */
export function useNovalisEvents() {
  useEffect(() => {
    const unlisten = [
      // A full (re)index — also fires when the last vault auto-opens on launch.
      events.reindexedEvent.listen(() => {
        void useVault.getState().sync();
      }),
      events.noteChanged.listen(() => {
        void useVault.getState().refreshTree();
      }),
      events.noteDeleted.listen(() => {
        void useVault.getState().refreshTree();
      }),
    ];
    return () => {
      for (const p of unlisten) void p.then((off) => off());
    };
  }, []);
}
