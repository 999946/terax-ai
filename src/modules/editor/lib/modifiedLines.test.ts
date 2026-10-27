import { ChangeSet, EditorState, Text } from "@codemirror/state";
import { Chunk } from "@codemirror/merge";
import { describe, expect, it } from "vitest";
import {
  changeLaneFromState,
  classifyChange,
  changedLines,
  marksFromHunks,
  modifiedField,
  overviewFromHunks,
  overviewFromState,
  setHunksEffect,
  textFromString,
  toEditorHunks,
  type GitLineHunk,
} from "./modifiedLines";

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
    const { cs, doc } = apply({ from: 0, insert: "X\n" });
    const chunks = Chunk.build(baseDoc(), doc);
    expect(kinds(changedLines(chunks, doc))).toEqual([[1, "added"]]);
    void cs;
  });

  it("marks a changed line as modified", () => {
    const { cs, doc } = apply({ from: 0, to: 1, insert: "aa" });
    const chunks = Chunk.build(baseDoc(), doc);
    expect(kinds(changedLines(chunks, doc))).toEqual([[1, "modified"]]);
    void cs;
  });

  it("marks the line at the deletion gap as deleted", () => {
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
    const { cs, doc } = apply({ from: 6, insert: "D" });
    const chunks = Chunk.build(baseDoc(), doc);
    expect(() => changedLines(chunks, doc)).not.toThrow();
    expect([...changedLines(chunks, doc).values()]).toContain("added");
    void cs;
  });
});

describe("toEditorHunks", () => {
  it("maps 0-based backend lines onto document offsets", () => {
    const doc = Text.of(["a", "b", "c", ""]);
    const hunks: GitLineHunk[] = [
      {
        kind: "added",
        start: 1,
        lines: 2,
        oldStart: 0,
        oldLines: 0,
        oldText: "",
      },
    ];
    const editor = toEditorHunks(hunks, doc);
    // start=1 (0-based) is the live line 2 ("b", offset 2); the hunk spans
    // lines 2-3, so `to` is the start of the following line (offset 6, the
    // empty 4th line).
    expect(editor[0].from).toBe(2);
    expect(editor[0].to).toBe(6);
  });

  it("places a pure deletion at its gap line", () => {
    const doc = Text.of(["a", "b", "c", ""]);
    const hunks: GitLineHunk[] = [
      {
        kind: "deleted",
        start: 1,
        lines: 0,
        oldStart: 1,
        oldLines: 2,
        oldText: "b\nc\n",
      },
    ];
    const editor = toEditorHunks(hunks, doc);
    expect(editor[0].from).toBe(editor[0].to);
    expect(editor[0].from).toBe(2);
  });
});

describe("modifiedField", () => {
  function drive(doc: Text, hunks: GitLineHunk[]) {
    let state = EditorState.create({ doc, extensions: [modifiedField] });
    state = state.update({ effects: [setHunksEffect.of(hunks)] }).state;
    return state;
  }

  it("adopts a fresh hunk set", () => {
    const doc = Text.of(["a", "b", "c", ""]);
    const state = drive(doc, [
      {
        kind: "modified",
        start: 1,
        lines: 1,
        oldStart: 1,
        oldLines: 1,
        oldText: "b\n",
      },
    ]);
    const hunks = state.field(modifiedField, false)!.hunks;
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.from).toBe(2);
  });

  it("remaps offsets through an edit above the hunk", () => {
    const doc = Text.of(["a", "b", "c", ""]);
    let state = drive(doc, [
      {
        kind: "modified",
        start: 1,
        lines: 1,
        oldStart: 1,
        oldLines: 1,
        oldText: "b\n",
      },
    ]);
    // The hunk lives on line 2 (offset 2, 0-based start 1).
    // Insert a line at the very top: the hunk's line shifts down by one.
    state = state.update({ changes: { from: 0, insert: "X\n" } }).state;
    const doc2 = state.doc;
    const h0 = state.field(modifiedField, false)!.hunks[0]!;
    // 0-based start stays 1 (a line), but its offset moves to line 3's start.
    expect(h0.from).toBe(doc2.line(3).from);
    expect(h0.to).toBe(doc2.line(4).from);
  });

  it("clamps hunks when the document below them is deleted", () => {
    const doc = Text.of(["a", "b", ""]);
    let state = drive(doc, [
      {
        kind: "added",
        start: 1,
        lines: 1,
        oldStart: 0,
        oldLines: 0,
        oldText: "",
      },
    ]);
    // Delete everything: the hunk's offsets clamp to the (empty) document.
    state = state.update({ changes: { from: 0, to: 4 } }).state;
    const hunks = state.field(modifiedField, false)!.hunks;
    expect(hunks.length).toBe(1);
    expect(hunks[0]!.from).toBeLessThanOrEqual(state.doc.length);
  });
});

describe("changeLaneFromState / overviewFromState", () => {
  it("maps a modified hunk into one change-lane mark", () => {
    const doc = Text.of(["a", "b", "c", ""]);
    const state = {
      hunks: [
        {
          kind: "modified" as const,
          start: 1,
          lines: 1,
          from: 2,
          to: 4,
          oldStart: 1,
          oldLines: 1,
          oldText: "b\n",
        },
      ],
    };
    const marks = changeLaneFromState(state, new Map(), doc);
    expect(marks).toEqual([{ line: 2, color: "modified" }]);
  });

  it("overrides an added line with conflict when both present", () => {
    const doc = Text.of(["a", "b", "c", ""]);
    const state = {
      hunks: [
        {
          kind: "added" as const,
          start: 1,
          lines: 1,
          from: 2,
          to: 4,
          oldStart: 0,
          oldLines: 0,
          oldText: "",
        },
      ],
    };
    const conflict = new Map<number, string>([[2, "conflict"]]);
    const marks = changeLaneFromState(state, conflict, doc);
    expect(marks.find((m) => m.line === 2)?.color).toBe("conflict");
  });

  it("returns an empty array when there are no hunks", () => {
    const doc = Text.of(["a", ""]);
    expect(changeLaneFromState(null, null, doc)).toEqual([]);
    expect(overviewFromState(null, null, doc)).toEqual([]);
  });

  it("maps contiguous changes into overview bands with doc offsets", () => {
    const doc = Text.of(["a", "b", "c", ""]);
    const bands = overviewFromHunks(
      [
        {
          kind: "added",
          start: 0,
          lines: 2,
          from: 0,
          to: 4,
          oldStart: 0,
          oldLines: 0,
          oldText: "",
        },
      ],
      doc,
    );
    expect(bands[0]).toMatchObject({ from: 0, to: 3, color: "added" });
  });

  it("surfaces conflict lines as deleted overview bands", () => {
    const doc = Text.of(["a", "b", "c", ""]);
    const state = {
      hunks: [
        {
          kind: "added" as const,
          start: 0,
          lines: 1,
          from: 0,
          to: 2,
          oldStart: 0,
          oldLines: 0,
          oldText: "",
        },
      ],
    };
    const conflict = new Map<number, string>([[1, "conflict"]]);
    const bands = overviewFromState(state, conflict, doc);
    expect(bands.some((b) => b.color === "deleted")).toBe(true);
  });

  it("marks a deleted hunk as one deleted bar", () => {
    const doc = Text.of(["a", "b", "c", ""]);
    const marks = marksFromHunks(
      [
        {
          kind: "deleted",
          start: 2,
          lines: 0,
          from: 4,
          to: 4,
          oldStart: 2,
          oldLines: 1,
          oldText: "c\n",
        },
      ],
      doc,
    );
    expect(marks).toEqual([{ line: 3, color: "deleted" }]);
  });
});
