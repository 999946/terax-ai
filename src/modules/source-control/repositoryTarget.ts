import type { SidebarViewId } from "@/modules/sidebar";

export type SourceControlRepositoryTarget =
  | { mode: "follow-context" }
  | { mode: "fixed"; repoRoot: string };

export type SourceControlRepositoryTargets = Readonly<
  Record<string, string>
>;

const FOLLOW_CONTEXT: SourceControlRepositoryTarget = {
  mode: "follow-context",
};

function targetScopeKey(spaceId: string, workspaceKey: string): string {
  return `${spaceId}\0${workspaceKey}`;
}

export function repositoryTargetForSpace(
  targets: SourceControlRepositoryTargets,
  spaceId: string,
  workspaceKey: string,
): SourceControlRepositoryTarget {
  const repoRoot = targets[targetScopeKey(spaceId, workspaceKey)];
  return repoRoot
    ? { mode: "fixed", repoRoot }
    : FOLLOW_CONTEXT;
}

export function setRepositoryTargetForSpace(
  targets: SourceControlRepositoryTargets,
  spaceId: string,
  workspaceKey: string,
  repoRoot: string,
): SourceControlRepositoryTargets {
  const key = targetScopeKey(spaceId, workspaceKey);
  if (targets[key] === repoRoot) return targets;
  return { ...targets, [key]: repoRoot };
}

export function clearRepositoryTargetForSpace(
  targets: SourceControlRepositoryTargets,
  spaceId: string,
  workspaceKey: string,
): SourceControlRepositoryTargets {
  const key = targetScopeKey(spaceId, workspaceKey);
  if (!(key in targets)) return targets;
  const next = { ...targets };
  delete next[key];
  return next;
}

export function activeRepositoryContextPath({
  explorerRoot,
}: {
  explorerRoot: string | null;
  workspaceFallbackPath?: string | null;
}): string | null {
  return explorerRoot;
}

export function sourceControlRepositoryPath({
  contextPath,
  badgeContextPath,
  sidebarView,
  hasOpenGitTab,
}: {
  contextPath: string | null;
  badgeContextPath: string | null;
  sidebarView: SidebarViewId;
  hasOpenGitTab: boolean;
  target: SourceControlRepositoryTarget;
}): string | null {
  // Source Control always re-scopes to the active Space root. A previously
  // pinned (fixed) repository must not re-point the panel at the settings root
  // or an old repo when the current Space root has no repository.
  return hasOpenGitTab || sidebarView === "source-control"
    ? contextPath
    : badgeContextPath;
}

export function gitGraphRepositoryPath({
  contextPath,
}: {
  contextPath: string | null;
  sidebarView: SidebarViewId;
  target: SourceControlRepositoryTarget;
}): string | null {
  // Same rule as the Source Control panel: always follow the active Space root,
  // never a pinned fixed repository.
  return contextPath;
}

export function repositoryTargetIsPending({
  target,
  loadedContextPath,
  loadedRepoRoot,
  isLoading,
}: {
  target: SourceControlRepositoryTarget;
  loadedContextPath: string | null;
  loadedRepoRoot: string | null;
  isLoading: boolean;
}): boolean {
  if (target.mode !== "fixed") return false;
  if (loadedContextPath !== target.repoRoot) return true;
  return isLoading && loadedRepoRoot !== target.repoRoot;
}
