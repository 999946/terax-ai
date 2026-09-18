import {
  type CloseManyHazards,
  type CloseManyKind,
  type CloseManyPending,
  evaluateCloseHazards,
  hasCloseManyHazards,
  hasNewCloseManyHazards,
} from "@/app/hooks/tabCloseGuards";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  type CloseTabsPlan,
  planCloseAllInSpace,
  planCloseOtherTabs,
  planCloseTabsToRight,
  type Tab,
} from "@/modules/tabs";
import { leafHasForegroundProcess, leafIds } from "@/modules/terminal";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

function confirmRunningTerminal(): boolean {
  return usePreferencesStore.getState().confirmCloseRunningTerminal;
}

type Params = {
  tabs: Tab[];
  activeId: number;
  disposeTab: (id: number) => void;
  disposeTabs: (anchorId: number, plan: CloseTabsPlan) => void;
  disposeAllTabsInSpace: (spaceId: string) => void;
};

/**
 * Guards tab closing: dirty editors and terminals with a live foreground
 * process route through a confirmation dialog instead of closing immediately.
 * Owns the pending-close states the dialogs render from.
 */
export function useTabCloseGuards({
  tabs,
  activeId,
  disposeTab,
  disposeTabs,
  disposeAllTabsInSpace,
}: Params) {
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;
  }, [tabs, activeId]);
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  const [pendingTerminalCloseTab, setPendingTerminalCloseTab] = useState<
    number | null
  >(null);
  const [pendingDeleteTabs, setPendingDeleteTabs] = useState<number[] | null>(
    null,
  );
  const [pendingCloseMany, setPendingCloseMany] =
    useState<CloseManyPending | null>(null);
  const [closeManyConfirming, setCloseManyConfirming] = useState(false);
  const closeManyRequestRef = useRef(0);

  const handleClose = useCallback(
    async (id: number) => {
      const t = tabs.find((x) => x.id === id);
      if (t?.kind === "editor" && t.dirty) {
        setPendingCloseTab(id);
        return;
      }
      if (t?.kind === "terminal" && confirmRunningTerminal()) {
        const leaves = leafIds(t.paneTree);
        const checks = await Promise.all(leaves.map(leafHasForegroundProcess));
        if (checks.some(Boolean)) {
          setPendingTerminalCloseTab(id);
          return;
        }
      }
      disposeTab(id);
    },
    [tabs, disposeTab],
  );

  const captureCloseMany = useCallback((closeIds: number[]) => {
    const close = new Set(closeIds);
    const affected = tabsRef.current.filter((tab) => close.has(tab.id));
    return {
      dirtyIds: affected
        .filter((tab) => tab.kind === "editor" && tab.dirty)
        .map((tab) => tab.id),
      leafIds: affected
        .filter((tab) => tab.kind === "terminal")
        .flatMap((tab) => leafIds(tab.paneTree)),
    };
  }, []);

  const evaluateCloseMany = useCallback(
    (closeIds: number[]): Promise<CloseManyHazards> =>
      evaluateCloseHazards(
        () => captureCloseMany(closeIds),
        leafHasForegroundProcess,
        confirmRunningTerminal(),
      ),
    [captureCloseMany],
  );

  const planCloseMany = useCallback(
    (kind: CloseManyKind, anchorId: number) =>
      kind === "right"
        ? planCloseTabsToRight(tabsRef.current, anchorId, activeIdRef.current)
        : kind === "other"
          ? planCloseOtherTabs(tabsRef.current, anchorId, activeIdRef.current)
          : planCloseAllInSpace(tabsRef.current, anchorId, activeIdRef.current),
    [],
  );

  const withCurrentActive = useCallback(
    (plan: CloseTabsPlan): CloseTabsPlan => ({
      closeIds: plan.closeIds,
      nextActiveId: activeIdRef.current,
    }),
    [],
  );

  const applyCloseMany = useCallback(
    (kind: CloseManyKind, anchorId: number, plan: CloseTabsPlan) => {
      if (kind === "all") {
        const anchor = tabsRef.current.find((t) => t.id === anchorId);
        if (anchor) disposeAllTabsInSpace(anchor.spaceId);
        return;
      }
      disposeTabs(anchorId, withCurrentActive(plan));
    },
    [disposeAllTabsInSpace, disposeTabs, withCurrentActive],
  );

  const handleCloseMany = useCallback(
    async (kind: CloseManyKind, anchorId: number) => {
      const plan = planCloseMany(kind, anchorId);
      if (plan.closeIds.length === 0) return;
      const requestId = ++closeManyRequestRef.current;
      const hazards = await evaluateCloseMany(plan.closeIds);
      if (requestId !== closeManyRequestRef.current) return;
      if (hasCloseManyHazards(hazards)) {
        setPendingCloseMany({ kind, anchorId, plan, ...hazards });
        return;
      }
      applyCloseMany(kind, anchorId, plan);
    },
    [applyCloseMany, evaluateCloseMany, planCloseMany],
  );

  const handleCloseTabsToRight = useCallback(
    (anchorId: number) => {
      void handleCloseMany("right", anchorId);
    },
    [handleCloseMany],
  );

  const handleCloseOtherTabs = useCallback(
    (anchorId: number) => {
      void handleCloseMany("other", anchorId);
    },
    [handleCloseMany],
  );

  const handleCloseAll = useCallback(
    (anchorId: number) => {
      void handleCloseMany("all", anchorId);
    },
    [handleCloseMany],
  );

  const confirmCloseMany = useCallback(async () => {
    if (pendingCloseMany === null) return;
    const requestId = ++closeManyRequestRef.current;
    setCloseManyConfirming(true);
    const hazards = await evaluateCloseMany(pendingCloseMany.plan.closeIds);
    if (requestId !== closeManyRequestRef.current) return;
    if (hasNewCloseManyHazards(pendingCloseMany, hazards)) {
      setPendingCloseMany({ ...pendingCloseMany, ...hazards });
      setCloseManyConfirming(false);
      return;
    }
    applyCloseMany(
      pendingCloseMany.kind,
      pendingCloseMany.anchorId,
      pendingCloseMany.plan,
    );
    setPendingCloseMany(null);
    setCloseManyConfirming(false);
  }, [pendingCloseMany, applyCloseMany, evaluateCloseMany]);

  const cancelCloseMany = useCallback(() => {
    closeManyRequestRef.current += 1;
    setPendingCloseMany(null);
    setCloseManyConfirming(false);
  }, []);

  const confirmClose = useCallback(() => {
    if (pendingCloseTab !== null) {
      disposeTab(pendingCloseTab);
      setPendingCloseTab(null);
    }
  }, [pendingCloseTab, disposeTab]);

  const cancelClose = useCallback(() => {
    setPendingCloseTab(null);
  }, []);

  const confirmTerminalClose = useCallback(() => {
    if (pendingTerminalCloseTab !== null) disposeTab(pendingTerminalCloseTab);
    setPendingTerminalCloseTab(null);
  }, [pendingTerminalCloseTab, disposeTab]);

  const cancelTerminalClose = useCallback(() => {
    setPendingTerminalCloseTab(null);
  }, []);

  const confirmDeleteClose = useCallback(() => {
    if (pendingDeleteTabs !== null) {
      for (const id of pendingDeleteTabs) disposeTab(id);
      setPendingDeleteTabs(null);
    }
  }, [pendingDeleteTabs, disposeTab]);

  const cancelDeleteClose = useCallback(() => {
    setPendingDeleteTabs(null);
  }, []);

  const handlePathDeleted = useCallback(
    (path: string) => {
      const dirty: number[] = [];
      for (const t of tabs) {
        if (t.kind !== "editor") continue;
        if (t.path !== path && !t.path.startsWith(`${path}/`)) continue;
        if (t.dirty) {
          dirty.push(t.id);
        } else {
          disposeTab(t.id);
        }
      }
      if (dirty.length > 0) setPendingDeleteTabs(dirty);
    },
    [tabs, disposeTab],
  );

  return {
    pendingCloseTab,
    pendingTerminalCloseTab,
    pendingDeleteTabs,
    pendingCloseMany,
    closeManyConfirming,
    handleClose,
    handleCloseTabsToRight,
    handleCloseOtherTabs,
    handleCloseAll,
    confirmClose,
    cancelClose,
    confirmTerminalClose,
    cancelTerminalClose,
    confirmDeleteClose,
    cancelDeleteClose,
    confirmCloseMany,
    cancelCloseMany,
    handlePathDeleted,
  };
}
