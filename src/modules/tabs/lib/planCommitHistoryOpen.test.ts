import { describe, expect, it } from "vitest";
import { planCommitHistoryOpen, type GitHistoryTab, type Tab } from "./useTabs";

function history(
  id: number,
  repoRoot: string,
  spaceId = "space-a",
  path: string | null = null,
  title = "Git History",
): GitHistoryTab {
  return {
    id,
    kind: "git-history",
    spaceId,
    title,
    repoRoot,
    path,
  };
}

describe("planCommitHistoryOpen", () => {
  it("reuses a repository history tab within the active Space", () => {
    const existing = history(1, "/repos/a");
    let allocations = 0;
    const result = planCommitHistoryOpen(
      [existing],
      { repoRoot: "/repos/a", branch: "main" },
      "space-a",
      () => {
        allocations += 1;
        return 2;
      },
    );

    expect(result.targetId).toBe(1);
    expect(result.tabs[0]).toMatchObject({ title: "History · main" });
    expect(allocations).toBe(0);

    const repeated = planCommitHistoryOpen(
      result.tabs,
      { repoRoot: "/repos/a", branch: "main" },
      "space-a",
      () => 2,
    );
    expect(repeated.tabs).toBe(result.tabs);
  });

  it("opens separate tabs for separate repositories", () => {
    const existing = history(1, "/repos/a");
    const result = planCommitHistoryOpen(
      [existing],
      { repoRoot: "/repos/b", branch: "feature" },
      "space-a",
      () => 2,
    );

    expect(result.targetId).toBe(2);
    expect(result.tabs).toEqual([
      existing,
      expect.objectContaining({
        id: 2,
        repoRoot: "/repos/b",
        spaceId: "space-a",
        title: "History · feature",
      }),
    ]);
  });

  it("does not activate a matching repository tab from another Space", () => {
    const otherSpace = history(1, "/repos/shared", "space-b");
    const tabs: Tab[] = [otherSpace];
    const result = planCommitHistoryOpen(
      tabs,
      { repoRoot: "/repos/shared" },
      "space-a",
      () => 2,
    );

    expect(result.targetId).toBe(2);
    expect(result.tabs).toEqual([
      otherSpace,
      expect.objectContaining({
        id: 2,
        repoRoot: "/repos/shared",
        spaceId: "space-a",
      }),
    ]);
  });

  it("dedupes by (repoRoot, path) so a scoped history is distinct from repo-wide", () => {
    const repoWide = history(1, "/repos/a", "space-a", null);
    const fileHistory = history(
      2,
      "/repos/a",
      "space-a",
      "/repos/a/src/x.ts",
      "History · x.ts",
    );
    const tabs: Tab[] = [repoWide, fileHistory];

    // Re-opening the same file history focuses the existing tab (no alloc).
    const repeated = planCommitHistoryOpen(
      tabs,
      { repoRoot: "/repos/a", path: "/repos/a/src/x.ts" },
      "space-a",
      () => 3,
    );
    expect(repeated.targetId).toBe(2);
    expect(repeated.tabs).toBe(tabs);

    // A repo-wide history (no path) is its own tab, not the file history.
    const repoAgain = planCommitHistoryOpen(
      tabs,
      { repoRoot: "/repos/a" },
      "space-a",
      () => 3,
    );
    expect(repoAgain.targetId).toBe(1);
    expect(repoAgain.tabs).toBe(tabs);

    // A NEW scoped path creates a fresh tab with a basename title.
    const fresh = planCommitHistoryOpen(
      tabs,
      { repoRoot: "/repos/a", path: "/repos/a/README.md" },
      "space-a",
      () => 3,
    );
    expect(fresh.targetId).toBe(3);
    expect(fresh.tabs[2]).toMatchObject({ path: "/repos/a/README.md" });
    expect(fresh.tabs[2].title).toBe("History · README.md");
  });
});
