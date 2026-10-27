import { native, type GitLineHunk } from "@/modules/ai/lib/native";
import { currentWorkspaceScopeKey } from "@/modules/workspace";

// Hunk results depend on the unsaved buffer text, so unlike the old HEAD-text
// cache they must never be reused by path alone. Keep only request generations
// here; callers discard results after a view/path switch.
const inflight = new Map<string, Promise<GitLineHunk[]>>();

function requestKey(repoRoot: string, path: string): string {
  return `${currentWorkspaceScopeKey()}|${repoRoot}|${path}`;
}

/** Cancel bookkeeping for requests belonging to the given paths. */
export function invalidateGitBaselinesForPaths(paths: string[]): void {
  const suffixSet = new Set(paths.map((p) => p.replace(/\\/g, "/")));
  for (const key of inflight.keys()) {
    const path = key.slice(key.lastIndexOf("|") + 1).replace(/\\/g, "/");
    if (suffixSet.has(path)) inflight.delete(key);
  }
}

/**
 * Compute hunks for the current unsaved buffer against HEAD. Do not cache the
 * result by path: two successive unsaved texts for one file have different
 * hunk sets. The editor's view/path guards and debounce handle stale results.
 */
export async function fetchGitHunks(
  repoRoot: string,
  path: string,
  currentText: string,
): Promise<GitLineHunk[]> {
  const key = requestKey(repoRoot, path);
  // Avoid duplicate requests for the same path while a request is in flight.
  // The debounce and view guard prevent an older response from being applied.
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = native.gitLineHunks(repoRoot, path, currentText).finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}
