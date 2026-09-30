import { ChangeSet, Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import { describe, expect, it } from "vitest";
import { classifyChange, changedLines, textFromString } from "./modifiedLines";

/** Baseline doc: "a\nb\nc\n" (Text.of(['a','b','c',''])). */
function baseDoc(): Text {
  return Text.of(["a", "b", "c", ""]);
}

/** Apply `changes` to the baseline and return (changes, docAfter). */
function apply(
  changes: { from: number; to?: number; insert?: string },
  doc = baseDoc(),
) {
  const cs = ChangeSet.of(changes, doc.length);
  return { cs, doc: cs.apply(doc) };
}

function kinds(map: Map<number, string>): [number, string][] {
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

describe("textFromString", () => {
  it("splits multi-line text on LF", () => {
    expect(textFromString("x\ny").toString()).toBe("x\ny");
  });

  it("keeps a trailing newline", () => {
    expect(textFromString("x\n").toString()).toBe("x\n");
  });

  it("handles an empty string", () => {
    expect(textFromString("").toString()).toBe("");
  });

  it("handles a single line without a newline", () => {
    expect(textFromString("solo").toString()).toBe("solo");
  });
});

describe("classifyChange", () => {
  it("classifies an insertion as added", () => {
    expect(
      classifyChange({ fromA: 1, toA: 1, fromB: 1, toB: 4 } as never),
    ).toBe("added");
  });

  it("classifies a deletion as deleted", () => {
    expect(
      classifyChange({ fromA: 1, toA: 4, fromB: 1, toB: 1 } as never),
    ).toBe("deleted");
  });

  it("classifies a replacement as modified", () => {
    expect(
      classifyChange({ fromA: 1, toA: 3, fromB: 2, toB: 5 } as never),
    ).toBe("modified");
  });
});

describe("changedLines", () => {
  it("marks a full inserted line as added", () => {
    // Insert "X\n" at the very start → B line 1 is new.
    const { cs, doc } = apply({ from: 0, insert: "X\n" });
    const chunks = Chunk.build(baseDoc(), doc);
    expect(kinds(changedLines(chunks, doc))).toEqual([[1, "added"]]);
    void cs;
  });

  it("marks a changed line as modified", () => {
    // Rewrite "a" → "aa" inside line 1.
    const { cs, doc } = apply({ from: 0, to: 1, insert: "aa" });
    const chunks = Chunk.build(baseDoc(), doc);
    expect(kinds(changedLines(chunks, doc))).toEqual([[1, "modified"]]);
    void cs;
  });

  it("marks the line at the deletion gap as deleted", () => {
    // Delete disk line 2 ("b\n", positions [2,4)) → B doc "a\nc\n". The gap
    // sits at position 2, the top of what is now line 2.
    const { cs, doc } = apply({ from: 2, to: 4 });
    const chunks = Chunk.build(baseDoc(), doc);
    expect(kinds(changedLines(chunks, doc))).toEqual([[2, "deleted"]]);
    void cs;
  });

  it("returns an empty map when base and doc are equal", () => {
    const doc = baseDoc();
    expect(kinds(changedLines(Chunk.build(baseDoc(), doc), doc))).toEqual([]);
  });

  it("handles an EOF insertion without overflowing", () => {
    // Append after "a\nb\nc" at position doc.length.
    const { cs, doc } = apply({ from: 6, insert: "D" });
    const chunks = Chunk.build(baseDoc(), doc);
    expect(() => changedLines(chunks, doc)).not.toThrow();
    // The appended line is flagged.
    expect([...changedLines(chunks, doc).values()]).toContain("added");
    void cs;
  });
});

describe("incremental update", () => {
  it("keeps offsets stable when a second edit lands above the first", () => {
    // Start from a baseline, insert a line at the top → B.
    const one = apply({ from: 0, insert: "X\n" });
    let chunks = Chunk.build(baseDoc(), one.doc);

    // Now a second edit ABOVE the first change (insert another line at top).
    const cs2 = ChangeSet.of({ from: 0, insert: "Y\n" }, one.doc.length);
    const doc2 = cs2.apply(one.doc);
    chunks = Chunk.updateB(chunks, baseDoc(), doc2, cs2);

    // Both added lines survive and land on B line 1 and 2.
    const map = changedLines(chunks, doc2);
    expect(kinds(map)).toEqual([
      [1, "added"],
      [2, "added"],
    ]);
  });

  it("clears markers once the baseline equals the live doc", () => {
    // A fully added doc; once the baseline is set to the same text, nothing shows.
    const doc = textFromString("lone\n");
    expect(kinds(changedLines(Chunk.build(doc, doc), doc))).toEqual([]);
  });
});
