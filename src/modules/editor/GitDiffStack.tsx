import type { GitCommitFileDiffTab, GitDiffTab, Tab } from "@/modules/tabs";
import { ConflictMergePane } from "./ConflictMergePane";
import { GitDiffPane } from "./GitDiffPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** Called after a hunk-level stage/discard or a conflict resolution writes
   * the index/worktree, so the source-control panel and open editor baselines
   * can refresh. */
  onHunkStaged?: (repoRoot: string, path: string) => void;
};

export function GitDiffStack({ tabs, activeId, onHunkStaged }: Props) {
  const active = tabs.find(
    (t): t is GitDiffTab | GitCommitFileDiffTab =>
      (t.kind === "git-diff" || t.kind === "git-commit-file") &&
      t.id === activeId,
  );
  if (!active) return null;
  if (active.kind === "git-diff") {
    // A conflicted (unmerged) file opens the three-pane merge editor instead of
    // the working diff.
    if (active.conflict) {
      return (
        <div className="h-full w-full">
          <ConflictMergePane
            key={active.id}
            active
            repoRoot={active.repoRoot}
            path={active.path}
            onResolved={onHunkStaged}
          />
        </div>
      );
    }
    return (
      <div className="h-full w-full">
        <GitDiffPane
          key={active.id}
          active
          source={{
            kind: "working",
            repoRoot: active.repoRoot,
            path: active.path,
            mode: active.mode,
            originalPath: active.originalPath,
          }}
          onHunkStaged={onHunkStaged}
        />
      </div>
    );
  }
  return (
    <div className="h-full w-full">
      <GitDiffPane
        key={active.id}
        active
        source={{
          kind: "commit",
          repoRoot: active.repoRoot,
          sha: active.sha,
          path: active.path,
          originalPath: active.originalPath,
        }}
        chipLabel={active.shortSha}
      />
    </div>
  );
}
