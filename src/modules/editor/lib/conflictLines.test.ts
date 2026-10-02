import { describe, expect, it } from "vitest";
import { conflictRanges } from "./conflictLines";

function lines(map: Map<number, string>): number[] {
  return [...map.keys()].sort((a, b) => a - b);
}

describe("conflictRanges", () => {
  it("returns empty for text without markers", () => {
    expect(conflictRanges("just\nsome\ncode\n").size).toBe(0);
  });

  it("marks a single conflict region inclusive of the separator", () => {
    const text = [
      "function f() {",
      "<<<<<<< HEAD",
      "  return 1;",
      "=======",
      "  return 2;",
      ">>>>>>> feature",
      "}",
    ].join("\n");
    const out = conflictRanges(text);
    // Lines 2..6 (the whole region, 1-based), including the ======= line.
    expect(lines(out)).toEqual([2, 3, 4, 5, 6]);
    expect(out.get(4)).toBe("conflict");
  });

  it("marks multiple separate conflict regions", () => {
    const text = [
      "<<<<<<< HEAD",
      "a",
      ">>>>>>> one",
      "fine",
      "<<<<<<< HEAD",
      "b",
      ">>>>>>> two",
    ].join("\n");
    const out = conflictRanges(text);
    expect(lines(out)).toEqual([1, 2, 3, 5, 6, 7]);
  });

  it("marks to EOF for an unclosed opening marker", () => {
    const text = ["a", "<<<<<<< HEAD", "b", "c"].join("\n");
    const out = conflictRanges(text);
    expect(lines(out)).toEqual([2, 3, 4]);
  });

  it("ignores an equals line outside any conflict region", () => {
    const text = ["const x = 1;", "=======", "const y = 2;"].join("\n");
    expect(conflictRanges(text).size).toBe(0);
  });

  it("handles an empty document", () => {
    expect(conflictRanges("").size).toBe(0);
  });

  it("does not treat a marker-like prefix mid-line as a marker", () => {
    // Only a line *starting* with <<<<<<< opens a region.
    const text = "  <<<<<<< not a marker\nend";
    expect(conflictRanges(text).size).toBe(0);
  });
});
