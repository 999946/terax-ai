import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { GitBlameEntry } from "@/modules/ai/lib/native";
import { relativeTime, remapBlameMap } from "./blameBadge";

const entry = (line: number, sha = `s${line}`): GitBlameEntry => ({
  line,
  sha,
  shortSha: sha.slice(0, 7),
  author: `Author ${line}`,
  authorEmail: `a${line}@x.io`,
  timestampSecs: 0,
  subject: `Subject ${line}`,
});

/** The committed file on disk (what `git blame` line numbers refer to). */
function diskDoc(): Text {
  // Text.of(['a','b','c','']) == "a\nb\nc\n" — a trailing newline after line 3.
  return Text.of(["a", "b", "c", ""]);
}

/** One entry per committed line, keyed by the disk doc's line numbers. */
const blameMap = () =>
  new Map<number, GitBlameEntry>([
    [1, entry(1)],
    [2, entry(2)],
    [3, entry(3)],
  ]);

/** Apply `changes` to a disk doc and return (changes, oldDoc, newDoc). */
function apply(changes: { from: number; to?: number; insert?: string }) {
  const oldDoc = diskDoc();
  const cs = ChangeSet.of(changes, oldDoc.length);
  const newDoc = cs.apply(oldDoc);
  return { changes: cs, oldDoc, newDoc };
}

function lines(result: Map<number, GitBlameEntry>): number[] {
  return [...result.keys()];
}

describe("remapBlameMap line tracking", () => {
  it("is a no-op when the map is empty", () => {
    const { changes, oldDoc, newDoc } = apply({ from: 0, insert: "X\n" });
    const result = remapBlameMap(new Map(), changes, oldDoc, newDoc);
    expect(result).toEqual(new Map());
  });

  it("shifts every committed line down when a line is inserted above", () => {
    const { changes, oldDoc, newDoc } = apply({ from: 0, insert: "X\n" });
    const result = remapBlameMap(blameMap(), changes, oldDoc, newDoc);
    expect(lines(result)).toEqual([2, 3, 4]);
    expect(result.get(2)?.subject).toBe("Subject 1");
  });

  it("shifts lines up when a line is deleted", () => {
    // Delete disk line 1 ("a\n"), positions [0,2) → "b\nc\n".
    const { changes, oldDoc, newDoc } = apply({ from: 0, to: 2 });
    const result = remapBlameMap(blameMap(), changes, oldDoc, newDoc);
    expect(lines(result)).toEqual([1, 2]);
    expect(result.get(2)?.subject).toBe("Subject 3");
  });

  it("keeps lines stable for in-line edits that add no lines", () => {
    // Rewrite "a" → "aa" inside line 1 without crossing the newline.
    const { changes, oldDoc, newDoc } = apply({ from: 0, to: 1, insert: "aa" });
    const result = remapBlameMap(blameMap(), changes, oldDoc, newDoc);
    expect(lines(result)).toEqual([1, 2, 3]);
  });

  it("drops the entry whose target line was deleted", () => {
    // Delete disk line 2 ("b\n"), positions [2,4) → "a\nc\n".
    const { changes, oldDoc, newDoc } = apply({ from: 2, to: 4 });
    const result = remapBlameMap(blameMap(), changes, oldDoc, newDoc);
    expect(lines(result)).toEqual([1, 2]);
    // New line 2 holds the entry that belonged to disk line 3.
    expect(result.get(2)?.subject).toBe("Subject 3");
  });
});

describe("relativeTime", () => {
  const now = Date.now() / 1000;

  it("renders an empty label for a zero/absent timestamp", () => {
    expect(relativeTime(0)).toBe("");
  });

  it("renders 'just now' under a minute", () => {
    expect(relativeTime(now - 30)).toBe("just now");
  });

  it("renders minutes, hours, days and months", () => {
    expect(relativeTime(now - 3 * 60)).toBe("3m ago");
    expect(relativeTime(now - 2 * 3600)).toBe("2h ago");
    expect(relativeTime(now - 2 * 86400)).toBe("2d ago");
    expect(relativeTime(now - 2 * 30 * 86400)).toBe("2mo ago");
  });
});
