import { describe, expect, it } from "vitest";
import { partitionGitRepos } from "./useGitAutoRefresh";

const REPOS = [{ repoRoot: "/repo" }, { repoRoot: "/nested" }];

describe("partitionGitRepos", () => {
  it("routes worktree changes to the containing repo", () => {
    const { worktree, meta } = partitionGitRepos(
      [{ path: "/repo/src/app.ts", kind: "updated" }],
      REPOS,
    );
    expect(worktree).toEqual(["/repo"]);
    expect(meta).toEqual([]);
  });

  it("routes .git metadata changes to the repo, not the worktree set", () => {
    const { worktree, meta } = partitionGitRepos(
      [
        { path: "/repo/.git/index", kind: "updated" },
        { path: "/repo/.git/HEAD", kind: "updated" },
      ],
      REPOS,
    );
    expect(worktree).toEqual([]);
    expect(meta).toEqual(["/repo"]);
  });

  it("treats any .git path the backend emitted as git-meta", () => {
    // Rust whitelist already filters noise like refs/heads and index.lock;
    // the frontend never re-filters, it just routes.
    const { worktree, meta } = partitionGitRepos(
      [
        // A refs/heads write would only arrive if the Rust whitelist passed
        // it through.
        { path: "/repo/.git/refs/heads/main", kind: "updated" },
      ],
      REPOS,
    );
    expect(worktree).toEqual([]);
    expect(meta).toEqual(["/repo"]);
  });

  it("routes to every repo that contains the path (nested repos)", () => {
    const { worktree, meta } = partitionGitRepos(
      [{ path: "/nested/.git/index", kind: "updated" }],
      REPOS,
    );
    expect(worktree).toEqual([]);
    expect(meta).toEqual(["/nested"]);
  });

  it("ignores paths outside all known repos", () => {
    const { worktree, meta } = partitionGitRepos(
      [{ path: "/elsewhere/file.ts", kind: "deleted" }],
      REPOS,
    );
    expect(worktree).toEqual([]);
    expect(meta).toEqual([]);
  });

  it("matches worktree deletions as worktree changes", () => {
    const { worktree, meta } = partitionGitRepos(
      [{ path: "/repo/removed.ts", kind: "deleted" }],
      REPOS,
    );
    expect(worktree).toEqual(["/repo"]);
    expect(meta).toEqual([]);
  });
});
