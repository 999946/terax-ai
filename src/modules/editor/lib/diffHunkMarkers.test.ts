import { describe, expect, it } from "vitest";
import type { GitHunk } from "@/modules/ai/lib/native";
import type { LineKind } from "./modifiedLines";
import { hunkAnchorLines, rulerMarks } from "./diffHunkMarkers";

/** Minimal hunk fixture: only the fields the pure functions read. */
function hunk(newStart: number, newCount: number, oldCount = 0): GitHunk {
  return {
    oldStart: 1,
    oldCount,
    newStart,
    newCount,
    header: "@@ -1," + oldCount + " +" + newStart + "," + newCount + " @@",
    lines: [],
  };
}

function kinds(lines: [number, LineKind][]): Map<number, LineKind> {
  return new Map(lines);
}

describe("hunkAnchorLines", () => {
  it("anchors an add/mod hunk on its newStart line", () => {
    const hunks = [hunk(3, 5), hunk(10, 2)];
    expect(hunkAnchorLines(hunks, 20)).toEqual([
      { index: 0, line: 3 },
      { index: 1, line: 10 },
    ]);
  });

  it("keeps hunk order and preserves the original index", () => {
    const hunks = [hunk(10, 2), hunk(3, 5)];
    expect(hunkAnchorLines(hunks, 20)).toEqual([
      { index: 0, line: 10 },
      { index: 1, line: 3 },
    ]);
  });

  it("anchors a deletion-only hunk on newStart (the line above the gap)", () => {
    // newCount 0: no room in B; the checkbox sits on the first B line after the gap.
    const hunks = [hunk(5, 0, 3)];
    expect(hunkAnchorLines(hunks, 20)).toEqual([{ index: 0, line: 5 }]);
  });

  it("clamps a hunk past the end of a short document", () => {
    const hunks = [hunk(40, 2), hunk(2, 1)];
    expect(hunkAnchorLines(hunks, 10)).toEqual([
      { index: 0, line: 10 },
      { index: 1, line: 2 },
    ]);
  });

  it("clamps to line 1 in an empty document", () => {
    expect(hunkAnchorLines([hunk(1, 0, 2)], 0)).toEqual([
      { index: 0, line: 1 },
    ]);
  });

  it("returns no anchors for no hunks", () => {
    expect(hunkAnchorLines([], 10)).toEqual([]);
  });
});

describe("rulerMarks", () => {
  it("merges contiguous same-kind lines into one band", () => {
    const changed = kinds([
      [3, "added"],
      [4, "added"],
      [5, "added"],
    ]);
    expect(rulerMarks(changed, 10)).toEqual([{ from: 3, to: 5, kind: "add" }]);
  });

  it("keeps separated bands apart", () => {
    const changed = kinds([
      [1, "added"],
      [5, "added"],
    ]);
    expect(rulerMarks(changed, 10)).toEqual([
      { from: 1, to: 1, kind: "add" },
      { from: 5, to: 5, kind: "add" },
    ]);
  });

  it("splits an add/del adjacency into two bands", () => {
    const changed = kinds([
      [2, "modified"],
      [3, "deleted"],
    ]);
    expect(rulerMarks(changed, 10)).toEqual([
      { from: 2, to: 2, kind: "add" },
      { from: 3, to: 3, kind: "del" },
    ]);
  });

  it("treats modified lines as add bands", () => {
    const changed = kinds([[7, "modified"]]);
    expect(rulerMarks(changed, 20)).toEqual([{ from: 7, to: 7, kind: "add" }]);
  });

  it("marks a pure-deletion block as del", () => {
    const changed = kinds([
      [4, "deleted"],
      [5, "deleted"],
    ]);
    expect(rulerMarks(changed, 20)).toEqual([{ from: 4, to: 5, kind: "del" }]);
  });

  it("clamps from/to into the document bounds", () => {
    const changed = kinds([
      [-1, "added"],
      [30, "deleted"],
    ]);
    expect(rulerMarks(changed, 10)).toEqual([
      { from: 1, to: 1, kind: "add" },
      { from: 10, to: 10, kind: "del" },
    ]);
  });

  it("returns [] for an empty map", () => {
    expect(rulerMarks(new Map(), 10)).toEqual([]);
  });

  it("returns [] when the document has no lines", () => {
    expect(rulerMarks(kinds([[1, "added"]]), 0)).toEqual([]);
  });
});
