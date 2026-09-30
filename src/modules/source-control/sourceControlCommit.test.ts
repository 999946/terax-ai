import { describe, expect, it } from "vitest";
import { normalizeStatusCode } from "./useSourceControlPanel";
import { statusColor } from "./statusTokens";

describe("normalizeStatusCode", () => {
  it("maps untracked '?' to U", () => {
    expect(normalizeStatusCode("?")).toBe("U");
  });

  it("passes through single-letter porcelain codes", () => {
    expect(normalizeStatusCode("A")).toBe("A");
    expect(normalizeStatusCode("M")).toBe("M");
    expect(normalizeStatusCode("D")).toBe("D");
    expect(normalizeStatusCode("U")).toBe("U");
  });

  it("maps rename and copy codes to R", () => {
    expect(normalizeStatusCode("R")).toBe("R");
    expect(normalizeStatusCode("C")).toBe("R");
  });

  it("defaults empty input to M", () => {
    expect(normalizeStatusCode("")).toBe("M");
    expect(normalizeStatusCode("   ")).toBe("M");
  });

  it("normalizes case and whitespace", () => {
    expect(normalizeStatusCode(" m ")).toBe("M");
  });
});

describe("statusColor (theme-aware status text colors)", () => {
  it("colors added and untracked files with the added token", () => {
    expect(statusColor("A")).toBe("text-added");
    expect(statusColor("U")).toBe("text-added");
  });

  it("colors modified and renamed files with the modified token", () => {
    expect(statusColor("M")).toBe("text-modified");
    expect(statusColor("R")).toBe("text-modified");
  });

  it("colors deleted files with the deleted token", () => {
    expect(statusColor("D")).toBe("text-deleted");
  });

  it("falls back to muted foreground for unknown codes", () => {
    expect(statusColor("T")).toBe("text-muted-foreground");
    expect(statusColor("")).toBe("text-muted-foreground");
  });
});
