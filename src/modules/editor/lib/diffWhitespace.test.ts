import { describe, expect, it } from "vitest";
import { diffConfigFor, whitespaceOverride } from "./diffWhitespace";

const changes = (
  policy: "none" | "trim" | "whitespace" | "whitespaceAndLines",
  a: string,
  b: string,
) => whitespaceOverride(policy)(a, b);

describe("whitespaceOverride", () => {
  it("reports a whitespace-only change under 'Do not ignore'", () => {
    // "none" never uses the override, but its projection is the identity.
    expect(changes("none", "a b", "a  b")).toHaveLength(1);
  });

  it("trims both ends of each line, which IDEA calls trimming", () => {
    expect(changes("trim", "a b  \nc\n", "a b\nc\n")).toHaveLength(0);
    expect(changes("trim", "  a b\nc\n", "a b\nc\n")).toHaveLength(0);
    // Inner runs are not whitespace at a line end, so they still differ.
    expect(changes("trim", "a b\nc\n", "a  b\nc\n")).toHaveLength(1);
  });

  it("ignores any whitespace, including inner runs", () => {
    expect(changes("whitespace", "a b\nc\n", "a  b\n c\n")).toHaveLength(0);
    expect(changes("whitespace", "a b\n", "a c\n")).toHaveLength(1);
  });

  it("drops empty lines entirely", () => {
    expect(changes("whitespaceAndLines", "a\n\n\nb\n", "a\nb\n")).toHaveLength(
      0,
    );
  });

  it("keeps offsets inside the real text", () => {
    const [change] = changes("whitespace", "a b", "a c");
    expect(change.fromA).toBeGreaterThanOrEqual(0);
    expect(change.toA).toBeLessThanOrEqual("a b".length);
  });
});

describe("diffConfigFor", () => {
  it("omits the override for 'Do not ignore'", () => {
    expect(diffConfigFor("none")).toEqual({});
  });

  it("provides an override for every ignoring policy", () => {
    for (const policy of ["trim", "whitespace", "whitespaceAndLines"] as const)
      expect(diffConfigFor(policy).override).toBeTypeOf("function");
  });
});
