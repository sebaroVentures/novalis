import { useEffect } from "react";

import { events } from "../ipc/api";
import { useTasks } from "../stores/taskStore";
import { useVault } from "../stores/vaultStore";

/** Subscribe to backend vault events and keep the UI in sync. */
export function useNovalisEvents() {
  useEffect(() => {
    const refresh = () => {
      void useVault.getState().refreshTree();
      void useTasks.getState().load();
    };
    const unlisten = [
      // A full (re)index — also fires when the last vault auto-opens on launch.
      events.reindexedEvent.listen(() => {
        void useVault.getState().sync();
        void useTasks.getState().load();
      }),
      events.noteChanged.listen(refresh),
      events.noteDeleted.listen(refresh),
    ];
    return () => {
      for (const p of unlisten) void p.then((off) => off());
    };
  }, []);
}
