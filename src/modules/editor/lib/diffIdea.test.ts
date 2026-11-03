import { Chunk, Change } from "@codemirror/merge";
import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { changedLines, chunkKind } from "./diffIdea";

/** A one-fragment chunk over the given ranges; the texts are implied by them. */
function chunk(fromA: number, toA: number, fromB: number, toB: number): Chunk {
  return new Chunk(
    [new Change(0, toA - fromA, 0, toB - fromB)],
    fromA,
    toA,
    fromB,
    toB,
  );
}

describe("chunkKind", () => {
  it("classifies by the sides that carry lines", () => {
    expect(chunkKind(chunk(0, 1, 0, 1))).toBe("modified");
    expect(chunkKind(chunk(0, 0, 0, 1))).toBe("inserted");
    expect(chunkKind(chunk(0, 1, 0, 0))).toBe("deleted");
  });
});

describe("changedLines", () => {
  const doc = Text.of(["one", "two", "three"]);

  it("marks every line of a multi-line chunk", () => {
    // Lines 2..3 of the doc, replaced wholesale.
    const lines = changedLines([chunk(4, 9, 0, 1)], "a", doc);
    expect(lines.map((l) => l.line)).toEqual([2, 3]);
    expect(lines.every((l) => l.kind === "modified")).toBe(true);
  });

  it("marks the boundary line where the other side has rows this one lacks", () => {
    const lines = changedLines([chunk(8, 8, 0, 3)], "a", doc);
    expect(lines).toHaveLength(1);
    expect(lines[0].kind).toBe("inserted");
  });

  it("clamps a range past the end of the document to its last line", () => {
    const lines = changedLines([chunk(12, 14, 0, 1)], "a", doc);
    expect(lines).toEqual([{ line: 3, kind: "modified", fine: false }]);
  });

  it("marks word-compared chunks as fine only when words are compared", () => {
    const target = chunk(4, 9, 0, 1);
    const coarse = changedLines([target], "a", doc);
    const words = changedLines([target], "a", doc, true);
    expect(coarse.every((l) => !l.fine)).toBe(true);
    expect(words.every((l) => l.fine)).toBe(true);
  });

  it("returns nothing for an empty chunk list", () => {
    expect(changedLines([], "b", doc)).toEqual([]);
  });
});
