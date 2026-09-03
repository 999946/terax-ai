import { useCallback, useMemo } from "react";
import { native } from "@/modules/ai/lib/native";
import type { SidebarViewId } from "@/modules/sidebar";
import type { Tab } from "@/modules/tabs";
import {
  activeRepositoryContextPath,
  gitGraphRepositoryPath,
  sourceControlRepositoryPath,
  type SourceControlRepositoryTarget,
} from "./repositoryTarget";
import { useSourceControl } from "./useSourceControl";
import { useMultiSourceControl } from "./useMultiSourceControl";

type Params = {
  activeTab: Tab | undefined;
  tabs: Tab[];
  activeTerminalLeafCwd: string | null;
  explorerRoot: string | null;
  launchCwd: string | null;
  launchCwdResolved: boolean;
  home: string | null;
  sidebarView: SidebarViewId;
  repositoryTarget: SourceControlRepositoryTarget;
  cycleSidebarView: (view: SidebarViewId) => void;
  openCommitHistoryTab: (args: {
    repoRoot: string;
    branch: string | null;
  }) => void;
};

/**
 * Resolves the source-control context path off the active tab and feeds the
 * source-control summary. When git is not active the badge tracks a stable
 * per-session path so tab switches / cd don't re-fire git IPC.
 */
export function useSourceControlContext({
  activeTab,
  tabs,
  activeTerminalLeafCwd,
  explorerRoot,
  launchCwd,
  launchCwdResolved,
  home,
  sidebarView,
  repositoryTarget,
  cycleSidebarView,
  openCommitHistoryTab,
}: Params) {
  const workspaceFallbackPath = launchCwdResolved
    ? (launchCwd ?? home ?? null)
    : null;
  const sourceControlContextPath = activeRepositoryContextPath({
    activeTab,
    activeTerminalLeafCwd,
    explorerRoot,
    workspaceFallbackPath,
  });
  const hasOpenGitTab = useMemo(
    () =>
      tabs.some(
        (t) =>
          t.kind === "git-diff" ||
          t.kind === "git-history" ||
          t.kind === "git-commit-file",
      ),
    [tabs],
  );
  // Ambient path tracks the explorer root so the rail badge and explorer git
  // decorations reflect the repo you are actually looking at. cd-within-repo
  // churn is absorbed by the status TTL + reusable-root path in useSourceControl.
  const badgeContextPath = explorerRoot ?? workspaceFallbackPath;
  const sourceControlPath = sourceControlRepositoryPath({
    contextPath: sourceControlContextPath,
    badgeContextPath,
    sidebarView,
    hasOpenGitTab,
    target: repositoryTarget,
  });
  const graphContextPath = gitGraphRepositoryPath({
    contextPath: sourceControlContextPath,
    sidebarView,
    target: repositoryTarget,
  });
  const sourceControl = useSourceControl(sourceControlPath, true);
  const multiSourceControl = useMultiSourceControl(sourceControlContextPath, true);
  const focusedRepository = useMemo(
    () =>
      multiSourceControl.repositories.find(
        (repository) => repository.repo.repoRoot === multiSourceControl.focusedRoot,
      ) ?? multiSourceControl.repositories[0],
    [multiSourceControl.focusedRoot, multiSourceControl.repositories],
  );
  const focusedSourceControl = focusedRepository?.summary ?? sourceControl;

  const toggleSourceControl = useCallback(() => {
    cycleSidebarView("source-control");
  }, [cycleSidebarView]);

  const openGitGraphFromContext = useCallback(async () => {
    const known = sourceControl.hasRepo ? sourceControl.repo : null;
    const fixedTargetIsLoaded =
      sidebarView !== "source-control" ||
      repositoryTarget.mode !== "fixed" ||
      known?.repoRoot === repositoryTarget.repoRoot;
    if (known && fixedTargetIsLoaded) {
      openCommitHistoryTab({
        repoRoot: known.repoRoot,
        branch: sourceControl.status?.branch ?? null,
      });
      return;
    }
    if (!graphContextPath) return;
    try {
      const repo = await native.gitResolveRepo(graphContextPath);
      if (!repo) return;
      openCommitHistoryTab({ repoRoot: repo.repoRoot, branch: repo.branch });
    } catch {
      /* noop */
    }
  }, [
    openCommitHistoryTab,
    sourceControl.hasRepo,
    sourceControl.repo,
    sourceControl.status?.branch,
    graphContextPath,
    repositoryTarget,
    sidebarView,
  ]);

  const repositories = useMemo(
    () =>
      multiSourceControl.repositories.map((repository) => {
        const status = repository.status;
        return {
          repoRoot: repository.repo.repoRoot,
          label: repository.repo.repoRoot.replace(/\\/g, "/").split("/").filter(Boolean).slice(-1)[0] ?? repository.repo.repoRoot,
          branch: status?.isDetached ? "detached" : status?.branch ?? repository.repo.branch,
          ahead: status?.ahead ?? 0,
          behind: status?.behind ?? 0,
          stagedCount: status?.changedFiles.filter((file) => file.staged).length ?? 0,
          unstagedCount: status?.changedFiles.filter((file) => file.unstaged).length ?? 0,
          changedCount: status?.changedFiles.length ?? 0,
          statusLabel: status?.isDetached ? "detached" : status?.branch ?? repository.repo.branch,
          loading: repository.isLoading,
          error: repository.error,
        };
      }),
    [multiSourceControl.repositories],
  );
  return {
    sourceControl: focusedSourceControl,
    toggleSourceControl,
    openGitGraphFromContext,
    repositories,
    focusedRoot: multiSourceControl.focusedRoot,
    focusRepo: multiSourceControl.focusRepo,
    allChangedCount: repositories.reduce((total, repository) => total + repository.changedCount, 0),
    refresh: multiSourceControl.refresh,
  };
}
