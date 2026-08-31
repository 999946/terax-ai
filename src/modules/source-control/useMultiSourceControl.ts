import {
  native,
  type GitRepoInfo,
  type GitStatusSnapshot,
} from "@/modules/ai/lib/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SourceControlRemoteAction,
  SourceControlRemoteActionMode,
  SourceControlRemoteActionResult,
  SourceControlRefreshMode,
} from "./useSourceControl";

type RepoData = {
  repo: GitRepoInfo;
  status: GitStatusSnapshot | null;
  isLoading: boolean;
  error: string | null;
};

export type RepoState = RepoData & {
  summary: {
    contextPath: string | null;
    repo: GitRepoInfo | null;
    status: GitStatusSnapshot | null;
    changedCount: number;
    upstream: string | null;
    ahead: number;
    behind: number;
    hasRepo: boolean;
    isLoading: boolean;
    localError: string | null;
    busyAction: SourceControlRemoteAction | null;
    lastRemoteError: string | null;
    applyStatus: (
      updater: (status: GitStatusSnapshot) => GitStatusSnapshot,
    ) => void;
    refresh: (options?: {
      remote?: SourceControlRefreshMode;
    }) => Promise<void>;
    runRemoteAction: (
      mode?: SourceControlRemoteActionMode,
    ) => Promise<SourceControlRemoteActionResult>;
  };
};

function normalizeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Unknown source control error";
}

function isSameRepo(a: GitRepoInfo | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.repoRoot === b;
}

export function useMultiSourceControl(
  contextPath: string | null,
  enabled: boolean = true,
): {
  repositories: RepoState[];
  focusedRoot: string | null;
  loading: boolean;
  error: string | null;
  focusRepo: (root: string) => void;
  refresh: () => Promise<void>;
} {
  // Normalize null so the fallback path is explicit.
  const [repos, setRepos] = useState<GitRepoInfo[]>([]);
  const [data, setData] = useState<Record<string, RepoData>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusedRoot, setFocusedRoot] = useState<string | null>(null);
  const focusedRootRef = useRef<string | null>(null);
  focusedRootRef.current = focusedRoot;
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const requestId = ++requestIdRef.current;
    if (!enabled || !contextPath) {
      setRepos([]);
      setData({});
      setFocusedRoot(null);
      setLoading(false);
      setError(null);
      return () => {
        mountedRef.current = false;
      };
    }

    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const found = await native.gitListRepos(contextPath);
        if (!mountedRef.current || requestId !== requestIdRef.current) return;
        setRepos(found);
        if (!focusedRootRef.current && found.length > 0) {
          setFocusedRoot(found[0].repoRoot);
        }
        setLoading(false);
      } catch (e) {
        if (!mountedRef.current || requestId !== requestIdRef.current) return;
        setLoading(false);
        setError(normalizeError(e));
      }
    })();

    const requestIds = requestIdRef;
    return () => {
      mountedRef.current = false;
      requestIds.current++;
    };
  }, [enabled, contextPath]);

  // Load status for each repo (keyed by repoRoot). Runs when repos change.
  useEffect(() => {
    const requestId = ++requestIdRef.current;
    mountedRef.current = true;
    const roots = repos.map((r) => r.repoRoot);
    setData((prev) => {
      const next: Record<string, RepoData> = {};
      for (const root of roots) {
        const existing = prev[root];
        next[root] = existing
          ? { ...existing, isLoading: true }
          : {
              repo: repos.find((r) => r.repoRoot === root)!,
              status: null,
              isLoading: true,
              error: null,
            };
      }
      return next;
    });
    void (async () => {
      for (const root of roots) {
        if (!mountedRef.current || requestId !== requestIdRef.current) return;
        try {
          const status = await native.gitStatus(root);
          if (!mountedRef.current || requestId !== requestIdRef.current) return;
          setData((prev) => ({
            ...prev,
            [root]: prev[root]
              ? { ...prev[root], status, isLoading: false, error: null }
              : {
                  repo: repos.find((r) => r.repoRoot === root)!,
                  status,
                  isLoading: false,
                  error: null,
                },
          }));
        } catch (e) {
          if (!mountedRef.current || requestId !== requestIdRef.current) return;
          setData((prev) => ({
            ...prev,
            [root]: prev[root]
              ? { ...prev[root], isLoading: false, error: normalizeError(e) }
              : {
                  repo: repos.find((r) => r.repoRoot === root)!,
                  status: null,
                  isLoading: false,
                  error: normalizeError(e),
                },
          }));
        }
      }
    })();
    const requestIds = requestIdRef;
    return () => {
      mountedRef.current = false;
      requestIds.current++;
    };
  }, [repos]);

  const applyStatusFor = useCallback(
    (root: string, updater: (s: GitStatusSnapshot) => GitStatusSnapshot) => {
      setData((prev) => {
        const current = prev[root];
        if (!current?.status) return prev;
        const next = updater(current.status);
        if (next === current.status) return prev;
        return { ...prev, [root]: { ...current, status: next } };
      });
    },
    [],
  );

  const refreshRepo = useCallback(
    async (root: string, _remoteMode: SourceControlRefreshMode) => {
      setData((prev) =>
        prev[root]
          ? { ...prev, [root]: { ...prev[root], isLoading: true, error: null } }
          : prev,
      );
      try {
        const status = await native.gitStatus(root);
        setData((prev) =>
          prev[root]
            ? { ...prev, [root]: { ...prev[root], status, isLoading: false, error: null } }
            : prev,
        );
      } catch (e) {
        setData((prev) =>
          prev[root]
            ? { ...prev, [root]: { ...prev[root], isLoading: false, error: normalizeError(e) } }
            : prev,
        );
        throw e;
      }
    },
    [],
  );

  const refreshAll = useCallback(async () => {
    await Promise.all(repos.map((r) => refreshRepo(r.repoRoot, "never")));
  }, [refreshRepo, repos]);

  const runRemoteFor = useCallback(
    async (
      root: string,
      mode: SourceControlRemoteActionMode = "contextual",
    ): Promise<SourceControlRemoteActionResult> => {
      const current = data[root];
      if (!current?.repo || !current.status) {
        return { ok: false, action: null, blocked: "no-repo" };
      }
      const status = current.status;
      if (!status.upstream) {
        return { ok: false, action: null, blocked: "missing-upstream" };
      }
      const contextual =
        status.ahead > 0 && status.behind > 0
          ? null
          : status.behind > 0
            ? "pull"
            : status.ahead > 0
              ? "push"
              : "fetch";
      const action =
        mode === "contextual" ? contextual : (mode as SourceControlRemoteAction);
      if (!action) return { ok: false, action: null, blocked: "diverged" };
      try {
        if (action === "fetch" || action === "pull") {
          await native.gitFetch(root);
        }
        if (action === "pull") {
          await native.gitPullFfOnly(root);
        } else if (action === "push") {
          await native.gitPush(root);
        }
        await refreshRepo(root, "never");
        return { ok: true, action };
      } catch (e) {
        return { ok: false, action, error: normalizeError(e) };
      }
    },
    [data, refreshRepo],
  );

  const focusRepo = useCallback((root: string) => {
    setFocusedRoot(root);
  }, []);

  const repositories = useMemo<RepoState[]>(() => {
    return repos
      .map((repo) => {
        const d = data[repo.repoRoot];
        if (!d) return null;
        const actual = { ...d, repo };
        const summary: RepoState["summary"] = {
          contextPath,
          repo: actual.repo,
          status: actual.status,
          changedCount: actual.status?.changedFiles.length ?? 0,
          upstream: actual.status?.upstream ?? null,
          ahead: actual.status?.ahead ?? 0,
          behind: actual.status?.behind ?? 0,
          hasRepo: true,
          isLoading: actual.isLoading,
          localError: actual.error,
          busyAction: null,
          lastRemoteError: null,
          applyStatus: (updater) => applyStatusFor(actual.repo.repoRoot, updater),
          refresh: (options) => refreshRepo(actual.repo.repoRoot, options?.remote ?? "never"),
          runRemoteAction: (mode) => runRemoteFor(actual.repo.repoRoot, mode),
        };
        // Preserve repo identity so nested state setters with the same
        // summary object keep working across refreshes.
        const state: RepoState = { ...actual, summary };
        void state; // no-op to keep lint clean
        return state;
      })
      .filter((r): r is RepoState => r !== null);
  }, [data, contextPath, repos, applyStatusFor, refreshRepo, runRemoteFor]);

  const derivedFocused = focusedRoot ?? repositories[0]?.repo.repoRoot ?? null;

  return {
    repositories,
    focusedRoot: derivedFocused,
    loading,
    error,
    focusRepo,
    refresh: refreshAll,
  };
}

export function repoHasContext(
  repoRoot: string | null,
  contextPath: string | null,
): boolean {
  if (!repoRoot || !contextPath) return false;
  const root = repoRoot.replace(/[\\/]+$/, "");
  const ctx = contextPath.replace(/[\\/]+$/, "");
  const windows = /^[A-Za-z]:\//.test(root) && /^[A-Za-z]:\//.test(ctx);
  if (windows) {
    const lower = (s: string) => s.toLowerCase();
    return (
      lower(root) === lower(ctx) || ctx.startsWith(`${lower(root)}/`)
    );
  }
  return root === ctx || ctx.startsWith(`${root}/`);
}

export { isSameRepo };