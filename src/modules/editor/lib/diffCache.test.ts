import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeMock = vi.hoisted(() => ({
  gitDiffContent: vi.fn(),
  gitCommitFileDiff: vi.fn(),
  gitDiff: vi.fn(),
}));

vi.mock("@/modules/ai/lib/native", () => ({ native: nativeMock }));

const workspaceMock = vi.hoisted(() => ({
  currentWorkspaceScopeKey: vi.fn(() => "scope"),
}));

vi.mock("@/modules/workspace", () => workspaceMock);

import type { GitDiffContentResult } from "@/modules/ai/lib/native";

function result(modifiedContent: string): GitDiffContentResult {
  return {
    originalContent: "",
    modifiedContent,
    isBinary: false,
    fallbackPatch: "",
    truncated: false,
  };
}

async function loadModule() {
  return await import("./diffCache");
}

describe("git diff content cache", () => {
  beforeEach(() => {
    vi.resetModules();
    nativeMock.gitDiffContent.mockReset();
    nativeMock.gitCommitFileDiff.mockReset();
    nativeMock.gitDiff.mockReset();
    workspaceMock.currentWorkspaceScopeKey.mockClear();
    workspaceMock.currentWorkspaceScopeKey.mockReturnValue("scope");
  });

  it("scopes diff keys by workspace, repo, and kind", async () => {
    const { workingDiffKey, commitDiffKey } = await loadModule();

    expect(workingDiffKey("/repo", "src/a.ts", "-")).toBe(
      "scope|/repo|w|-|src/a.ts",
    );
    expect(commitDiffKey("/repo", "abc123", "src/a.ts")).toBe(
      "scope|/repo|c|abc123|src/a.ts",
    );
  });

  it("serves repeated reads of the same file from cache", async () => {
    const { fetchWorkingDiff } = await loadModule();
    nativeMock.gitDiffContent.mockResolvedValue(result("- line"));

    await fetchWorkingDiff("/repo", "a.ts", "-", null);
    const second = await fetchWorkingDiff("/repo", "a.ts", "-", null);

    expect(second.modifiedContent).toBe("- line");
    expect(nativeMock.gitDiffContent).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent reads of the same diff into one backend call", async () => {
    const { fetchWorkingDiff } = await loadModule();
    let release: ((v: GitDiffContentResult) => void) | undefined;
    nativeMock.gitDiffContent.mockReturnValue(
      new Promise<GitDiffContentResult>((r) => {
        release = r;
      }),
    );

    const first = fetchWorkingDiff("/repo", "a.ts", "-", null);
    const second = fetchWorkingDiff("/repo", "a.ts", "-", null);
    release?.(result("shared"));

    expect(await first).toBe(await second);
    expect(nativeMock.gitDiffContent).toHaveBeenCalledTimes(1);
  });

  it("evicts the least recently used entry past six", async () => {
    const mod = await loadModule();
    nativeMock.gitDiffContent.mockImplementation((_root, path: string) =>
      Promise.resolve(result(`body ${path}`)),
    );

    for (let i = 0; i < 6; i++) {
      await mod.fetchWorkingDiff("/repo", `f${i}.ts`, "-", null);
    }
    await mod.fetchWorkingDiff("/repo", "new.ts", "-", null);

    expect(
      mod.getCachedDiff(mod.workingDiffKey("/repo", "f0.ts", "-")),
    ).toBeUndefined();
    expect(
      mod.getCachedDiff(mod.workingDiffKey("/repo", "f1.ts", "-")),
    ).toBeDefined();
  });

  it("keeps an entry that was just read when the limit overflows", async () => {
    const { fetchWorkingDiff, getCachedDiff, workingDiffKey } =
      await loadModule();
    nativeMock.gitDiffContent.mockImplementation((_root, path: string) =>
      Promise.resolve(result(`body ${path}`)),
    );

    for (let i = 0; i < 6; i++) {
      await fetchWorkingDiff("/repo", `f${i}.ts`, "-", null);
    }
    getCachedDiff(workingDiffKey("/repo", "f0.ts", "-"));
    await fetchWorkingDiff("/repo", "new.ts", "-", null);

    expect(getCachedDiff(workingDiffKey("/repo", "f0.ts", "-"))).toBeDefined();
    expect(
      getCachedDiff(workingDiffKey("/repo", "f1.ts", "-")),
    ).toBeUndefined();
  });

  it("does not retry or cache a failed backend call", async () => {
    const { fetchWorkingDiff } = await loadModule();
    nativeMock.gitDiffContent
      .mockRejectedValueOnce(new Error("git failed"))
      .mockResolvedValueOnce(result("recovered"));

    await expect(fetchWorkingDiff("/repo", "a.ts", "-", null)).rejects.toThrow(
      "git failed",
    );
    await expect(fetchWorkingDiff("/repo", "a.ts", "-", null)).resolves.toEqual(
      result("recovered"),
    );
    expect(nativeMock.gitDiffContent).toHaveBeenCalledTimes(2);
  });

  it("invalidates only the current workspace scope for a repo root", async () => {
    const mod = await loadModule();
    const { fetchWorkingDiff, getCachedDiff, workingDiffKey } = mod;
    nativeMock.gitDiffContent.mockImplementation((_root, path: string) =>
      Promise.resolve(result(`body ${path}`)),
    );

    await fetchWorkingDiff("/repo-a", "x.ts", "-", null);

    workspaceMock.currentWorkspaceScopeKey.mockReturnValue("other");
    await fetchWorkingDiff("/repo-a", "x.ts", "-", null);
    workspaceMock.currentWorkspaceScopeKey.mockReturnValue("scope");

    const { invalidateRepoDiffs } = mod;
    invalidateRepoDiffs("/repo-a");

    expect(
      getCachedDiff(workingDiffKey("/repo-a", "x.ts", "-")),
    ).toBeUndefined();

    workspaceMock.currentWorkspaceScopeKey.mockReturnValue("other");
    expect(getCachedDiff(workingDiffKey("/repo-a", "x.ts", "-"))).toBeDefined();
  });

  it("keeps working-tree and commit diffs under separate namespaces", async () => {
    const { fetchWorkingDiff, fetchCommitDiff } = await loadModule();
    nativeMock.gitDiffContent.mockResolvedValue(result("work"));
    nativeMock.gitCommitFileDiff.mockResolvedValue(result("commit"));

    await fetchWorkingDiff("/repo", "a.ts", "+", null);
    await fetchCommitDiff("/repo", "sha1", "a.ts", null);

    expect(nativeMock.gitDiffContent).toHaveBeenCalledTimes(1);
    expect(nativeMock.gitCommitFileDiff).toHaveBeenCalledWith(
      "/repo",
      "sha1",
      "a.ts",
      null,
    );
  });

  it("parses hunks from git diff and caches by path + staged flag", async () => {
    const mod = await loadModule();
    nativeMock.gitDiff.mockResolvedValue({
      diffText: "…",
      truncated: false,
      hunks: [
        {
          oldStart: 1,
          oldCount: 2,
          newStart: 3,
          newCount: 4,
          header: "@@",
          lines: [],
        },
        {
          oldStart: 8,
          oldCount: 1,
          newStart: 9,
          newCount: 1,
          header: "@@",
          lines: [],
        },
      ],
    });

    const h1 = await mod.fetchWorkingHunks("/repo", "a.ts", true);
    const h2 = await mod.fetchWorkingHunks("/repo", "a.ts", true);
    const h3 = await mod.fetchWorkingHunks("/repo", "a.ts", false);

    expect(h1).toHaveLength(2);
    expect(nativeMock.gitDiff).toHaveBeenCalledTimes(2); // staged + unstaged once each
    expect(nativeMock.gitDiff).toHaveBeenCalledWith("/repo", "a.ts", true);
    expect(nativeMock.gitDiff).toHaveBeenCalledWith("/repo", "a.ts", false);
    expect(h2).toBe(h1); // served from cache
    expect(h3).toHaveLength(2);
  });

  it("invalidates content and hunk caches for a path on hunk mutation", async () => {
    const mod = await loadModule();
    nativeMock.gitDiffContent.mockResolvedValue(result("work"));
    nativeMock.gitDiff.mockResolvedValue({
      diffText: "…",
      truncated: false,
      hunks: [],
    });

    await mod.fetchWorkingDiff("/repo", "a.ts", "-", null);
    await mod.fetchWorkingHunks("/repo", "a.ts", false);

    mod.invalidateWorkingDiff("/repo", "a.ts");

    expect(
      mod.getCachedDiff(mod.workingDiffKey("/repo", "a.ts", "-")),
    ).toBeUndefined();
    expect(
      mod.getCachedDiff(mod.workingDiffKey("/repo", "a.ts", "+")),
    ).toBeUndefined();
  });

  it("relativizes absolute editor paths to repo-relative cache keys", async () => {
    const mod = await loadModule();
    expect(mod.toRepoRelativePath("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(mod.toRepoRelativePath("/repo/", "/repo/a.ts")).toBe("a.ts");
    expect(mod.toRepoRelativePath("/repo", "/repo")).toBe("");
    expect(mod.toRepoRelativePath("/repo", "/elsewhere/a.ts")).toBeNull();
  });

  it("invalidates working diffs from an absolute saved path", async () => {
    const mod = await loadModule();
    nativeMock.gitDiffContent.mockResolvedValue(result("work"));
    nativeMock.gitDiff.mockResolvedValue({
      diffText: "…",
      truncated: false,
      hunks: [],
    });

    await mod.fetchWorkingDiff("/repo", "src/a.ts", "-", null);
    await mod.fetchWorkingDiff("/repo", "src/a.ts", "+", null);
    await mod.fetchWorkingHunks("/repo", "src/a.ts", false);

    mod.invalidateWorkingDiffForPath("/repo", "/repo/src/a.ts");

    expect(
      mod.getCachedDiff(mod.workingDiffKey("/repo", "src/a.ts", "-")),
    ).toBeUndefined();
    expect(
      mod.getCachedDiff(mod.workingDiffKey("/repo", "src/a.ts", "+")),
    ).toBeUndefined();
  });

  it("clears a repo's working caches when the path cannot be relativized", async () => {
    const mod = await loadModule();
    nativeMock.gitDiffContent.mockResolvedValue(result("work"));
    nativeMock.gitCommitFileDiff.mockResolvedValue(result("commit"));

    await mod.fetchWorkingDiff("/repo", "src/a.ts", "-", null);
    await mod.fetchCommitDiff("/repo", "sha1", "src/a.ts", null);

    mod.invalidateWorkingDiffForPath("/repo", "/elsewhere/a.ts");

    // Working diff gone; commit diff unaffected (different namespace).
    expect(
      mod.getCachedDiff(mod.workingDiffKey("/repo", "src/a.ts", "-")),
    ).toBeUndefined();
    expect(
      mod.getCachedDiff(mod.commitDiffKey("/repo", "sha1", "src/a.ts")),
    ).toBeDefined();
  });

  it("invalidateRepoDiffs also clears the hunk cache", async () => {
    const mod = await loadModule();
    nativeMock.gitDiff.mockResolvedValue({
      diffText: "…",
      truncated: false,
      hunks: [],
    });

    await mod.fetchWorkingHunks("/repo", "b.ts", true);
    await mod.fetchWorkingHunks("/repo", "b.ts", false);

    mod.invalidateRepoDiffs("/repo");

    // Next fetch must hit the backend again, not the removed hunk cache.
    await mod.fetchWorkingHunks("/repo", "b.ts", true);
    expect(nativeMock.gitDiff).toHaveBeenCalledTimes(3);
  });
});
