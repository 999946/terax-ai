import { describe, expect, it } from "vitest";
import { parseQuery } from "./mode";

describe("parseQuery", () => {
  it("defaults (no prefix) to files mode with a trimmed term", () => {
    expect(parseQuery("  foo ")).toEqual({
      mode: "files",
      term: "foo",
      raw: "  foo ",
    });
  });

  it("routes > to commands", () => {
    expect(parseQuery(">th")).toMatchObject({ mode: "commands", term: "th" });
  });

  it("routes ! to command history", () => {
    expect(parseQuery("!git")).toMatchObject({ mode: "history", term: "git" });
  });

  it("routes # to content search", () => {
    expect(parseQuery("# useState")).toMatchObject({
      mode: "content",
      term: "useState",
    });
  });

  it("routes ? to help", () => {
    expect(parseQuery("?")).toMatchObject({ mode: "help", term: "" });
  });
});
