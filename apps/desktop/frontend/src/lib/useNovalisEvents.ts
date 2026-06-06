import { useEffect } from "react";

import { events } from "../ipc/api";
import { useConflicts } from "../stores/conflictStore";
import { useTasks } from "../stores/taskStore";
import { useUi } from "../stores/uiStore";
import { useVault } from "../stores/vaultStore";

// Coalesce bursts of `conflict-detected` (one per synced file) into a single scan.
let conflictScanTimer: number | null = null;
function scanConflictsSoon() {
  if (conflictScanTimer) window.clearTimeout(conflictScanTimer);
  conflictScanTimer = window.setTimeout(() => {
    conflictScanTimer = null;
    void useConflicts.getState().scan();
  }, 400);
}

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
        void useConflicts.getState().scan();
      }),
      events.conflictDetected.listen(() => scanConflictsSoon()),
      events.noteChanged.listen((e) => {
        const path = e.payload.path;
        const st = useVault.getState();
        if (st.activePath === path) {
          // The open note changed on disk: ignore our own echo, auto-reload when
          // clean, or prompt when there are unsaved edits (manages the cache).
          void st.handleExternalChange(path);
        } else {
          // Drop the cached copy so the next open re-reads the new content.
          st.invalidateNote(path);
        }
        refresh();
      }),
      events.noteDeleted.listen((e) => {
        const path = e.payload.path;
        useVault.getState().invalidateNote(path);
        useVault.getState().dropSaveState(path);
        // Close the deleted note's tab (in any pane). reconcileTabs (not
        // closeTab) so we DON'T flush — flushing would resurrect the
        // externally-deleted file. It re-syncs the live editor for both the
        // active-note and background-tab cases.
        useUi.getState().reconcileTabs((p) => (p === path ? null : p));
        refresh();
      }),
    ];
    return () => {
      for (const p of unlisten) void p.then((off) => off());
    };
  }, []);
}
