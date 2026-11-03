import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIFF_VIEWER_OPTIONS,
  parseDiffViewerOptions,
} from "./diffOptions";

describe("parseDiffViewerOptions", () => {
  it("falls back to the defaults for a missing value", () => {
    expect(parseDiffViewerOptions(null)).toEqual(DEFAULT_DIFF_VIEWER_OPTIONS);
    expect(parseDiffViewerOptions("nonsense")).toEqual(
      DEFAULT_DIFF_VIEWER_OPTIONS,
    );
  });

  it("keeps valid fields and repairs invalid ones per field", () => {
    const parsed = parseDiffViewerOptions({
      mode: "inline",
      ignore: "nope",
      highlight: "lines",
      collapse: "yes",
      syncScroll: false,
      alignChanges: true,
    });
    expect(parsed).toEqual({
      mode: "inline",
      ignore: DEFAULT_DIFF_VIEWER_OPTIONS.ignore,
      highlight: "lines",
      collapse: DEFAULT_DIFF_VIEWER_OPTIONS.collapse,
      syncScroll: false,
      alignChanges: true,
    });
  });

  it("accepts the whitespace-and-empty-lines policy", () => {
    expect(
      parseDiffViewerOptions({ ignore: "whitespaceAndLines" }).ignore,
    ).toBe("whitespaceAndLines");
  });

  it("defaults the viewer to an unpadded IDEA split view", () => {
    expect(DEFAULT_DIFF_VIEWER_OPTIONS.mode).toBe("split");
    expect(DEFAULT_DIFF_VIEWER_OPTIONS.collapse).toBe(false);
    expect(DEFAULT_DIFF_VIEWER_OPTIONS.alignChanges).toBe(false);
    expect(DEFAULT_DIFF_VIEWER_OPTIONS.syncScroll).toBe(true);
  });
});
