import { native } from "@/modules/ai/lib/native";
import { currentWorkspaceScopeKey } from "@/modules/workspace";

const BASELINE_CACHE_LIMIT = 6;
const inflight = new Map<string, Promise<string>>();
const cache = new Map<string, string>();

function baselineKey(repoRoot: string, path: string): string {
  return `${currentWorkspaceScopeKey()}|${repoRoot}|${path}`;
}

function touch(key: string, value: string) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > BASELINE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearGitBaselineCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Drop any cached/in-flight HEAD baseline for the given editor paths (the cache
 * is keyed by path per repo). Called after a commit so the next refetch reflects
 * the new HEAD - otherwise the markers would keep diffing against the old
 * committed text and show a false "changed" state on files that were just
 * committed. Untracked files resolve to "" (all-lines-added baseline), so an
 * untracked file that gets committed also needs this invalidation.
 */
export function invalidateGitBaselinesForPaths(paths: string[]): void {
  const suffixSet = new Set(paths.map((p) => p.replace(/\\/g, "/")));
  for (const key of cache.keys()) {
    const path = key.slice(key.lastIndexOf("|") + 1).replace(/\\/g, "/");
    if (suffixSet.has(path)) cache.delete(key);
  }
  for (const key of inflight.keys()) {
    const path = key.slice(key.lastIndexOf("|") + 1).replace(/\\/g, "/");
    if (suffixSet.has(path)) inflight.delete(key);
  }
}

export async function fetchGitBaseline(
  repoRoot: string,
  path: string,
): Promise<string> {
  const key = baselineKey(repoRoot, path);
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = native
    .gitHeadContent(repoRoot, path)
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
