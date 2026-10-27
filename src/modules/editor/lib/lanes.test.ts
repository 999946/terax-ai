import { Text } from "@codemirror/state";
import type { GutterMarker } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { buildLaneMarkers } from "./lanes";

/** Extract (line num -> color) from the built marker set against `text` lines. */
function laneColors(
  set: ReturnType<typeof buildLaneMarkers>,
  lines: string[],
): Record<number, string> {
  const d = Text.of([...lines, ""]);
  const out: Record<number, string> = {};
  const iter = set.iter();
  for (let cur = iter.value; cur; cur = iter.value) {
    const marker = cur as GutterMarker;
    const color = (marker as unknown as { color?: string }).color;
    out[d.lineAt(iter.from).number] = color ?? "";
    iter.next();
  }
  return out;
}

describe("buildLaneMarkers", () => {
  it("renders one marker per contributed line", () => {
    const d = Text.of(["a", "b", "c", ""]);
    const set = buildLaneMarkers(
      [
        { line: 1, color: "added" },
        { line: 3, color: "deleted" },
      ],
      d,
    );
    expect(laneColors(set, ["a", "b", "c"])).toEqual({
      1: "added",
      3: "deleted",
    });
  });

  it("merges two marks on the same line, conflict wins", () => {
    const d = Text.of(["a", "b", ""]);
    const set = buildLaneMarkers(
      [
        { line: 1, color: "added" },
        { line: 1, color: "conflict" },
      ],
      d,
    );
    expect(laneColors(set, ["a", "b"])).toEqual({ 1: "conflict" });
  });

  it("prefers added over modified over deleted", () => {
    const d = Text.of(["a", "b", "c", ""]);
    const addedWins = buildLaneMarkers(
      [
        { line: 1, color: "modified" },
        { line: 1, color: "added" },
      ],
      d,
    );
    expect(laneColors(addedWins, ["a", "b", "c"])).toEqual({ 1: "added" });

    const delVsMod = buildLaneMarkers(
      [
        { line: 2, color: "deleted" },
        { line: 2, color: "modified" },
      ],
      d,
    );
    expect(laneColors(delVsMod, ["a", "b", "c"])).toEqual({ 2: "modified" });
  });

  it("clamps out-of-range lines to the last line", () => {
    const d = Text.of(["a", "b", ""]);
    const set = buildLaneMarkers([{ line: 99, color: "added" }], d);
    expect(laneColors(set, ["a", "b", ""])).toEqual({ 3: "added" });
  });

  it("returns empty for no marks", () => {
    expect(buildLaneMarkers([], Text.of(["a", ""])).size).toBe(0);
  });

  it("clamps a mark in a one-line empty doc to line 1", () => {
    const d = Text.of([""]);
    const set = buildLaneMarkers([{ line: 5, color: "added" }], d);
    expect(laneColors(set, [""])).toEqual({ 1: "added" });
  });
});
