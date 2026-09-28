import { type GitBlameEntry, native } from "@/modules/ai/lib/native";
import { currentWorkspaceScopeKey } from "@/modules/workspace";

const BLAME_CACHE_LIMIT = 6;
const inflight = new Map<string, Promise<Map<number, GitBlameEntry>>>();
const cache = new Map<string, Map<number, GitBlameEntry>>();

function blameKey(repoRoot: string, path: string): string {
  return `${currentWorkspaceScopeKey()}|${repoRoot}|${path}`;
}

function toLineMap(entries: GitBlameEntry[]): Map<number, GitBlameEntry> {
  const map = new Map<number, GitBlameEntry>();
  for (const entry of entries) {
    if (entry.line > 0) map.set(entry.line, entry);
  }
  return map;
}

function touch(key: string, value: Map<number, GitBlameEntry>) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > BLAME_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearBlameCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Drop any cached/in-flight blame for `path` (across every repo root). Called
 * when a file is saved so the next blame refetch reflects the committed state —
 * otherwise the cache (keyed only by path) would keep serving the pre-save data.
 */
export function invalidateBlameForPath(path: string): void {
  const suffix = `|${path}`;
  for (const key of cache.keys()) {
    if (key.endsWith(suffix)) cache.delete(key);
  }
  for (const key of inflight.keys()) {
    if (key.endsWith(suffix)) inflight.delete(key);
  }
}

export async function fetchBlame(
  repoRoot: string,
  path: string,
): Promise<Map<number, GitBlameEntry>> {
  const key = blameKey(repoRoot, path);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = native
    .gitBlame(repoRoot, path)
    .then((res) => {
      const map = toLineMap(res.entries);
      touch(key, map);
      return map;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}
