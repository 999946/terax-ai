import {
  listenFsChanged,
  parentDir,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import type { Tab } from "@/modules/tabs";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type RefObject, useEffect, useRef } from "react";
import type { EditorPaneHandle } from "./EditorPane";

type EditorTabOf = Extract<Tab, { kind: "editor" }>;

type Params = {
  tabs: Tab[];
  tabsRef: RefObject<Tab[]>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
  /** Called once the external state (deleted/conflict) is decided for an open
   * editor tab. App applies it through `updateTab`. */
  onPatchTab: (
    id: number,
    patch: { deleted?: boolean; conflict?: boolean },
  ) => void;
};

/** Delay before probing the filesystem after a delete event (VSCode's
 * onDidFilesChange uses the same timeout to guard against network-share and
 * cross-platform false positives). */
const DELETE_PROBE_MS = 100;

/**
 * Keeps open editor tabs in sync with on-disk changes: reloads on applied AI
 * diffs, external writes, and fs-watch events, and maintains the watch set for
 * the directories of open editor files.
 *
 * External delete/rename/move events are unified through one path: probe the
 * filesystem after a short delay, and only when the path is really gone mark
 * the tab deleted (and conflict when the buffer is dirty).
 */
export function useEditorFileSync({
  tabs,
  tabsRef,
  editorRefs,
  onPatchTab,
}: Params) {
  // onPatchTab identity changes every render (it goes through updateTab); keep
  // the latest snapshot via a ref so the subscription effect stays mounted once.
  const patchRef = useRef(onPatchTab);
  patchRef.current = onPatchTab;

  // Tab ids with a pending delete probe, so overlapping delete events for the
  // same tab collapse into one fs-stat call.
  const pendingProbeRef = useRef<Set<number>>(new Set());
  // Mounted flag for the async probe so a tab closed mid-probe stays untouched.
  const aliveRef = useRef(true);

  // When an AI diff is approved (write_file applied to disk), reload any
  // open editor tabs for that path so the user sees the new content. We
  // track which approvalIds we've already handled to fire the reload only
  // once per applied diff.
  const appliedDiffsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const t of tabs) {
      if (t.kind !== "ai-diff") continue;
      if (t.status !== "approved") continue;
      if (appliedDiffsRef.current.has(t.approvalId)) continue;
      appliedDiffsRef.current.add(t.approvalId);
      for (const e of tabs) {
        if (e.kind !== "editor") continue;
        if (e.path !== t.path) continue;
        editorRefs.current.get(e.id)?.reload();
      }
    }
  }, [tabs, editorRefs]);

  useEffect(() => {
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise =
      getCurrentWebviewWindow().listen<FileWrittenPayload>(
        "fs:file-written",
        (event) => {
          if (event.payload.source === "editor") return;
          const normalizedPath = event.payload.path.replace(/\\/g, "/");
          const currentTabs = tabsRef.current;
          for (const t of currentTabs) {
            if (t.kind !== "editor") continue;
            if (t.path.replace(/\\/g, "/") === normalizedPath) {
              editorRefs.current.get(t.id)?.reload();
            }
          }
        },
      );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, [tabsRef, editorRefs]);

  const editorWatchRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const want = new Set<string>();
    for (const t of tabs) if (t.kind === "editor") want.add(parentDir(t.path));
    const prev = editorWatchRef.current;
    const toAdd = [...want].filter((d) => !prev.has(d));
    const toRemove = [...prev].filter((d) => !want.has(d));
    watchAdd(toAdd);
    watchRemove(toRemove);
    editorWatchRef.current = want;
  }, [tabs]);

  // React on fs:changed for open editor tabs.
  useEffect(() => {
    aliveRef.current = true;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listenFsChanged((changes) => {
      for (const c of changes) {
        const p = c.path.replace(/\\/g, "/");
        for (const t of tabsRef.current) {
          if (t.kind !== "editor") continue;
          if (p !== t.path.replace(/\\/g, "/")) continue;
          const h = editorRefs.current.get(t.id);
          if (!h) continue;
          if (c.kind === "deleted") handleDeletedEvent(t);
          else handleChangedEvent(t, h);
        }
      }
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      aliveRef.current = false;
      unlisten?.();
      pendingProbeRef.current.clear();
    };
  }, [tabsRef, editorRefs]);

  // A delete/rename/move event is only a hint: probe the filesystem after a
  // short delay (VSCode's onDidFilesChange does the same) before trusting it.
  // Atomic writes surface as Updated (the Rust EventCoalescer folds Delete→Add),
  // so a real delete here means the path is gone — except for network-share /
  // Windows false positives, which the probe filters out.
  const handleDeletedEvent = (t: EditorTabOf) => {
    if (t.deleted) return;
    if (pendingProbeRef.current.has(t.id)) return;
    pendingProbeRef.current.add(t.id);
    const path = t.path;
    const tabId = t.id;
    window.setTimeout(() => {
      pendingProbeRef.current.delete(tabId);
      void invoke<{ kind: string }>("fs_stat", {
        path,
        workspace: currentWorkspaceEnv(),
      })
        .then(() => {
          // The path still exists: a false positive (or the rename landed back).
          // Treat it as an ordinary external update.
          if (!aliveRef.current) return;
          const h2 = editorRefs.current.get(tabId);
          const t2 = tabsRef.current.find((x) => x.id === tabId);
          if (h2 && t2?.kind === "editor") handleChangedEvent(t2, h2);
        })
        .catch(() => {
          if (!aliveRef.current) return;
          // The file is really gone. Mark deleted; a dirty buffer cannot be
          // written back, so it also enters the conflict state.
          const tab = tabsRef.current.find((x) => x.id === tabId);
          if (tab?.kind !== "editor") return;
          patchRef.current(tabId, {
            deleted: true,
            ...(tab.dirty ? { conflict: true } : {}),
          });
        });
    }, DELETE_PROBE_MS);
  };

  // An update/add on an open tab: dirty buffers never auto-reload (VSCode
  // rule), so a dirty tab touched on disk enters the conflict state. A deleted
  // tab whose path reappears un-deletes and reloads; a clean conflict resolves
  // itself on a successful reload.
  const handleChangedEvent = (t: EditorTabOf, h: EditorPaneHandle) => {
    if (t.deleted) patchRef.current(t.id, { deleted: false, conflict: false });
    // reload() returns false only when the buffer is dirty (auto-reload skipped).
    const reloaded = h.reload();
    if (!reloaded) {
      patchRef.current(t.id, { conflict: true });
    } else if (t.conflict && !t.dirty) {
      patchRef.current(t.id, { conflict: false });
    }
  };
}
