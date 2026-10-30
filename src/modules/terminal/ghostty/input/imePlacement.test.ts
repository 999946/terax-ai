import { describe, expect, it } from "vitest";
import { imePlacementForCell } from "./imePlacement";

const OPTS = { cols: 80, rows: 24, cellWidthPx: 10, cellHeightPx: 20 };

describe("imePlacementForCell", () => {
  it("parks the textarea on the cursor cell", () => {
    expect(
      imePlacementForCell(
        { x: 5, y: 3, visible: true, blinking: false, style: "block" },
        OPTS,
      ),
    ).toEqual({ leftPx: 50, topPx: 60 });
  });

  it("clamps a scrolled-out cursor into the viewport", () => {
    expect(
      imePlacementForCell(
        { x: 200, y: 100, visible: false, blinking: false, style: "block" },
        OPTS,
      ),
    ).toEqual({ leftPx: 790, topPx: 460 });
  });

  it("never goes negative", () => {
    expect(
      imePlacementForCell(
        { x: -3, y: -1, visible: true, blinking: false, style: "block" },
        OPTS,
      ),
    ).toEqual({ leftPx: 0, topPx: 0 });
  });

  it("falls back to a sane cell size when metrics are zero", () => {
    expect(
      imePlacementForCell(
        { x: 1, y: 2, visible: true, blinking: false, style: "block" },
        { cols: 80, rows: 24, cellWidthPx: 0, cellHeightPx: 0 },
      ),
    ).toEqual({ leftPx: 8, topPx: 32 });
  });
});
