import { invalidateRepoDiffs } from "@/modules/editor/lib/diffCache";
import {
  gitMetaPath,
  listenFsChanged,
  watchGitAdd,
  watchGitRemove,
  type FsChange,
} from "@/modules/explorer/lib/watch";
import { useEffect, useRef } from "react";
import { repositoryContainsContext } from "./useSourceControl";

/** Batch window so a burst of fs events (a commit, a checkout) collapses into
 * one status refresh per repo. */
const REFRESH_DEBOUNCE_MS = 300;

type Params = {
  repositories: { repoRoot: string }[];
  refreshRepo: (repoRoot: string) => Promise<void> | void;
  /** Called when `.git` metadata moved (HEAD/index/refs): HEAD may have
   * changed, so baselines, blame and merge status must be invalidated. */
  onGitMetaChange: (repoRoot: string) => void;
};

/**
 * Drives git status refresh from the fs:changed stream so external git
 * operations (a commit in a terminal, a checkout, a pull) surface without a
 * window focus or manual refresh:
 *
 * - Worktree changes only re-read status (files changed on disk).
 * - `.git` metadata changes additionally call `onGitMetaChange` because HEAD
 *   may have moved (commit/checkout/pull all rewrite .git/HEAD or .git/index).
 *
 * Registers the `.git` metadata watches (B) for each known repo and releases
 * them when a repo leaves the set, and re-uses the existing status inflight
 * merging in useSourceControl/useMultiSourceControl, so bursts collapse.
 */
export function useGitAutoRefresh({
  repositories,
  refreshRepo,
  onGitMetaChange,
}: Params) {
  // Latest snapshot via refs so the subscription effect stays mounted once
  // even though App re-creates the repositories array on every status change.
  const reposRef = useRef(repositories);
  reposRef.current = repositories;
  const refreshRef = useRef(refreshRepo);
  refreshRef.current = refreshRepo;
  const onGitMetaRef = useRef(onGitMetaChange);
  onGitMetaRef.current = onGitMetaChange;
  const gitWatchedRef = useRef<Set<string>>(new Set());

  // Register .git metadata watches for newly discovered repos; release when a
  // repo goes away (window close, folder removed from the panel).
  useEffect(() => {
    const next = new Set(repositories.map((r) => r.repoRoot));
    const prev = gitWatchedRef.current;
    for (const root of next) {
      if (!prev.has(root)) watchGitAdd(root);
    }
    for (const root of prev) {
      if (!next.has(root)) watchGitRemove(root);
    }
    gitWatchedRef.current = next;
  }, [repositories]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    let timer: number | null = null;
    const pendingWorktree = new Set<string>();
    const pendingMeta = new Set<string>();

    const flush = () => {
      timer = null;
      for (const root of pendingWorktree) {
        invalidateRepoDiffs(root);
        void refreshRef.current(root);
      }
      for (const root of pendingMeta) {
        invalidateRepoDiffs(root);
        onGitMetaRef.current(root);
        void refreshRef.current(root);
      }
      pendingWorktree.clear();
      pendingMeta.clear();
    };

    void listenFsChanged((changes) => {
      const { worktree, meta } = partitionGitRepos(changes, reposRef.current);
      for (const root of worktree) pendingWorktree.add(root);
      for (const root of meta) pendingMeta.add(root);
      if (pendingWorktree.size === 0 && pendingMeta.size === 0) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(flush, REFRESH_DEBOUNCE_MS);
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });

    return () => {
      alive = false;
      unlisten?.();
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // Repos leaving the set should also release their .git watches on unmount.
  useEffect(
    () => () => {
      for (const root of gitWatchedRef.current) watchGitRemove(root);
    },
    [],
  );
}

/** Pure partition of `fs:changed` changes into affected repo roots, used by
 * the hook above and unit-testable without React. */
export function partitionGitRepos(
  changes: FsChange[],
  repos: { repoRoot: string }[],
): { worktree: string[]; meta: string[] } {
  const worktree = new Set<string>();
  const meta = new Set<string>();
  for (const c of changes) {
    const p = c.path.replace(/\\/g, "/");
    for (const repo of repos) {
      const root = repo.repoRoot.replace(/\\/g, "/").replace(/\/+$/, "");
      if (!repositoryContainsContext(root, p)) continue;
      if (gitMetaPath(p) !== null) meta.add(root);
      else worktree.add(root);
    }
  }
  return { worktree: [...worktree], meta: [...meta] };
}
