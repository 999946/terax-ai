import { describe, expect, it } from "vitest";
import { DEFAULT_DIFF_MODE, DIFF_MODES } from "./diffMode";

describe("diff mode", () => {
  it("defaults to split view", () => {
    expect(DEFAULT_DIFF_MODE).toBe("split");
  });

  it("exposes exactly the split and inline modes", () => {
    expect(DIFF_MODES).toEqual(["split", "inline"]);
  });
});
