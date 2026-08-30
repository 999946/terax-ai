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
    const rows = flattenChangeTree(buildChangeTree([entry("src/lib/a.ts")]), new Set());
    expect(rows.map((row) => row.key)).toEqual(["dir:src"]);
  });

  it("normalizes Windows paths", () => {
    const rows = flattenChangeTree(
      buildChangeTree([entry("src\\lib\\a.ts")]),
      new Set(["src", "src/lib"]),
    );
    expect(rows.map((row) => row.key)).toEqual([
      "dir:src",
      "dir:src/lib",
      "file:src/lib/a.ts",
    ]);
  });
});
