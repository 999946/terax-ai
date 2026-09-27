import { type GitMergeStatusResult, native } from "@/modules/ai/lib/native";
import { currentWorkspaceScopeKey } from "@/modules/workspace";

/**
 * Freshness window: merge status is refetched at most once per minute unless
 * forced. The key includes the target branches, so changing the setting
 * automatically produces a fresh entry.
 */
const MERGE_STATUS_TTL_MS = 60_000;

const inflight = new Map<string, Promise<GitMergeStatusResult | null>>();
const cache = new Map<
  string,
  { at: number; value: GitMergeStatusResult | null }
>();

function mergeKey(repoRoot: string, branches: string[]): string {
  return `${currentWorkspaceScopeKey()}|${repoRoot}|${branches.join(",")}`;
}

function drop(key: string) {
  cache.delete(key);
  while (cache.size > 16) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Fetch whether the current branch is merged into each of `branches`.
 *
 * - Returns the cached value if it is younger than one minute and `force` is
 *   false.
 * - Shares in-flight requests so concurrent callers don't duplicate the IPC.
 * - `force: true` bypasses both the cache and any pending request.
 */
export async function getMergeStatus(
  repoRoot: string,
  branches: string[],
  options?: { force?: boolean },
): Promise<GitMergeStatusResult | null> {
  const force = options?.force ?? false;
  const key = mergeKey(repoRoot, branches);

  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.at < MERGE_STATUS_TTL_MS) {
    return cached.value;
  }

  const pending = inflight.get(key);
  if (!force && pending) return pending;

  const p = native
    .gitMergeStatus(repoRoot, branches)
    .then((res) => {
      drop(key);
      cache.set(key, { at: Date.now(), value: res });
      return res;
    })
    .catch(() => {
      // A failed fetch shouldn't poison future attempts or the panel; the
      // caller renders its own error state.
      drop(key);
      return null;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}

/** Drop every cached merge-status entry for a repo (e.g. after commit/push). */
export function invalidateMergeStatus(repoRoot: string): void {
  const prefix = `${currentWorkspaceScopeKey()}|${repoRoot}|`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
