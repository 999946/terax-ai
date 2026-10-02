import {
  type GitDiffContentResult,
  type GitHunk,
  native,
} from "@/modules/ai/lib/native";
import { currentWorkspaceScopeKey } from "@/modules/workspace";

const DIFF_CACHE_LIMIT = 6;
const inflight = new Map<string, Promise<GitDiffContentResult>>();
const cache = new Map<string, GitDiffContentResult>();
/** Cache of parsed hunks per worktree/staged diff, so the hunk-staging strip
 * doesn't re-run `git diff` on every keystroke. */
const hunkCache = new Map<string, GitHunk[]>();
const hunkInflight = new Map<string, Promise<GitHunk[]>>();

function touch(key: string, value: GitDiffContentResult) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > DIFF_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function getCachedDiff(key: string): GitDiffContentResult | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

export function invalidateDiff(key: string): void {
  cache.delete(key);
}

export function invalidateRepoDiffs(repoRoot: string): void {
  const prefix = `${currentWorkspaceScopeKey()}|${repoRoot}|`;
  for (const k of [...cache.keys()]) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

export function workingDiffKey(
  repoRoot: string,
  path: string,
  mode: "-" | "+",
): string {
  return `${currentWorkspaceScopeKey()}|${repoRoot}|w|${mode}|${path}`;
}

export function commitDiffKey(
  repoRoot: string,
  sha: string,
  path: string,
): string {
  return `${currentWorkspaceScopeKey()}|${repoRoot}|c|${sha}|${path}`;
}

export function conflictDiffKey(repoRoot: string, path: string): string {
  return `${currentWorkspaceScopeKey()}|${repoRoot}|x|${path}`;
}

export function workingHunksKey(
  repoRoot: string,
  path: string,
  staged: boolean,
): string {
  return `${currentWorkspaceScopeKey()}|${repoRoot}|h|${staged ? "+" : "-"}|${path}`;
}

/** Invalidate both the reverse (reversed-flag) content caches and the hunk
 * cache for a path after a hunk-level accent stage/discard, so the diff pane
 * re-reads the new index/worktree state. */
export function invalidateWorkingDiff(repoRoot: string, path: string): void {
  invalidateDiff(workingDiffKey(repoRoot, path, "+"));
  invalidateDiff(workingDiffKey(repoRoot, path, "-"));
  invalidateDiff(conflictDiffKey(repoRoot, path));
  hunkCache.delete(workingHunksKey(repoRoot, path, true));
  hunkCache.delete(workingHunksKey(repoRoot, path, false));
}

/** Parse the hunks of a per-path worktree/staged diff. Mirrors the content
 * cache: coalesces concurrent reads and remembers the last list. */
export async function fetchWorkingHunks(
  repoRoot: string,
  path: string,
  staged: boolean,
): Promise<GitHunk[]> {
  const key = workingHunksKey(repoRoot, path, staged);
  const cached = hunkCache.get(key);
  if (cached) return cached;
  const pending = hunkInflight.get(key);
  if (pending) return pending;
  const p = native
    .gitDiff(repoRoot, path, staged)
    .then((res) => res.hunks ?? [])
    .then((hunks) => {
      hunkCache.set(key, hunks);
      return hunks;
    })
    .finally(() => {
      hunkInflight.delete(key);
    });
  hunkInflight.set(key, p);
  return p;
}

/**
 * Fetch the ours/theirs contents of an unmerged (conflicted) file via the
 * conflict-files command and pick the matching path. Reuses the diff cache so
 * repeated opens (and refresh toggles) don't re-read git blobs.
 */
export async function fetchConflictDiff(
  repoRoot: string,
  path: string,
): Promise<GitDiffContentResult> {
  const key = conflictDiffKey(repoRoot, path);
  const cached = getCachedDiff(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = native
    .gitConflictFiles(repoRoot)
    .then((files) => {
      const hit = files.find((f) => f.path === path);
      if (!hit || hit.isBinary) {
        return {
          originalContent: hit?.ours ?? "",
          modifiedContent: hit?.theirs ?? "",
          isBinary: hit?.isBinary ?? false,
          fallbackPatch: "",
          truncated: false,
        };
      }
      return {
        originalContent: hit.ours ?? "",
        modifiedContent: hit.theirs ?? "",
        isBinary: false,
        fallbackPatch: "",
        truncated: false,
      };
    })
    .then((res) => {
      touch(key, res);
      return res;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

export async function fetchWorkingDiff(
  repoRoot: string,
  path: string,
  mode: "-" | "+",
  originalPath: string | null,
): Promise<GitDiffContentResult> {
  const key = workingDiffKey(repoRoot, path, mode);
  const cached = getCachedDiff(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = native
    .gitDiffContent(repoRoot, path, mode === "+", originalPath)
    .then((res) => {
      touch(key, res);
      return res;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

export async function fetchCommitDiff(
  repoRoot: string,
  sha: string,
  path: string,
  originalPath: string | null,
): Promise<GitDiffContentResult> {
  const key = commitDiffKey(repoRoot, sha, path);
  const cached = getCachedDiff(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = native
    .gitCommitFileDiff(repoRoot, sha, path, originalPath)
    .then((res) => {
      touch(key, res);
      return res;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}
