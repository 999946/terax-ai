import { describe, expect, it } from "vitest";
import {
  normalizeStatusCode,
  splitCommitMessage,
} from "./useSourceControlPanel";
import { statusAccent, statusColor } from "./statusTokens";

describe("splitCommitMessage", () => {
  it("returns a single-line message with an empty body", () => {
    expect(splitCommitMessage("fix(git): bump version")).toEqual({
      subject: "fix(git): bump version",
      body: "",
    });
  });

  it("splits subject and body at the first blank line", () => {
    expect(splitCommitMessage("feat: add push\n\nCloses #12.")).toEqual({
      subject: "feat: add push",
      body: "Closes #12.",
    });
  });

  it("keeps multi-line body paragraphs, collapsing the blank separator to one", () => {
    expect(
      splitCommitMessage(
        "feat: add push\n\nBody line one.\nBody line two.\n\nTrailing para.",
      ),
    ).toEqual({
      subject: "feat: add push",
      body: "Body line one.\nBody line two.\n\nTrailing para.",
    });
  });

  it("trims surrounding whitespace from subject and body", () => {
    expect(splitCommitMessage("  fix: pad   \n\n  body pad  ")).toEqual({
      subject: "fix: pad",
      body: "body pad",
    });
  });

  it("normalizes CRLF line endings to LF", () => {
    expect(splitCommitMessage("fix: crlf\r\n\r\nbody")).toEqual({
      subject: "fix: crlf",
      body: "body",
    });
  });

  it("returns empty subject and body for blank input", () => {
    expect(splitCommitMessage("   \n \n  ")).toEqual({ subject: "", body: "" });
  });

  it("does not split on a subject that has no blank separator", () => {
    expect(
      splitCommitMessage("docs: single line with no body separator"),
    ).toEqual({
      subject: "docs: single line with no body separator",
      body: "",
    });
  });
});

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

describe("statusAccent (status bar accent token)", () => {
  it("uses the added accent for added and untracked files", () => {
    expect(statusAccent("A")).toBe("bg-added");
    expect(statusAccent("U")).toBe("bg-added");
  });

  it("uses the modified accent for modified and renamed files", () => {
    expect(statusAccent("M")).toBe("bg-modified");
    expect(statusAccent("R")).toBe("bg-modified");
  });

  it("uses the deleted accent for deleted files", () => {
    expect(statusAccent("D")).toBe("bg-deleted");
  });

  it("falls back to a muted accent for unknown codes", () => {
    expect(statusAccent("T")).toBe("bg-muted-foreground/40");
  });
});
