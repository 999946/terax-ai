import { describe, expect, it } from "vitest";
import type { SourceControlFileEntry } from "./useSourceControlPanel";
import { buildChangeTree, flattenChangeTree } from "./changeTree";

function entry(path: string): SourceControlFileEntry {
  return {
    key: path,
    path,
    originalPath: null,
    staged: false,
    unstaged: true,
    untracked: false,
    checkState: "unchecked",
    statusCode: "M",
    statusLabel: "Modified",
  };
}

describe("change tree", () => {
  it("groups nested paths and orders directories before files", () => {
    const rows = flattenChangeTree(
      buildChangeTree([entry("z.txt"), entry("src/b.ts"), entry("src/a.ts")]),
      new Set(["src"]),
    );
    expect(rows.map((row) => row.key)).toEqual([
      "dir:src",
      "file:src/a.ts",
      "file:src/b.ts",
      "file:z.txt",
    ]);
  });

  it("hides descendants of collapsed directories", () => {
    const rows = flattenChangeTree(
      buildChangeTree([entry("src/lib/a.ts")]),
      new Set(["src/lib"]),
    );
    expect(rows.map((row) => row.key)).toEqual([
      "dir:src/lib",
      "file:src/lib/a.ts",
    ]);
  });

  it("normalizes Windows paths", () => {
    const rows = flattenChangeTree(
      buildChangeTree([entry("src\\lib\\a.ts")]),
      new Set(["src/lib"]),
    );
    expect(rows.map((row) => row.key)).toEqual([
      "dir:src/lib",
      "file:src/lib/a.ts",
    ]);
  });

  it("collapses a chain of empty dirs into a single node", () => {
    const rows = flattenChangeTree(
      buildChangeTree([entry("src/a/b/c/file.ts")]),
      new Set(["src/a/b/c"]),
    );
    expect(rows.map((row) => row.key)).toEqual([
      "dir:src/a/b/c",
      "file:src/a/b/c/file.ts",
    ]);
  });

  it("keeps a directory that contains files expanded", () => {
    const rows = flattenChangeTree(
      buildChangeTree([entry("src/a.ts"), entry("src/b/c.ts")]),
      new Set(["src", "src/b"]),
    );
    expect(rows.map((row) => row.key)).toEqual([
      "dir:src",
      "dir:src/b",
      "file:src/b/c.ts",
      "file:src/a.ts",
    ]);
  });
});
