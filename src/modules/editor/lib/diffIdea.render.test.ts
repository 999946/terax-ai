/**
 * Rendering-level test for the IDEA diff pane.
 *
 * Mounts a real `MergeView` with the pane extension and asserts the DOM it
 * produces: whole changed lines, tinted line-number gutters with the right
 * change type, and word fragments in their own type colour. Pure-function tests
 * can't see whether the extension is wired into the editor and paints anything.
 */
// @vitest-environment happy-dom
import { MergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ideaDiffPane } from "./diffIdea";
import { diffConfigFor } from "./diffWhitespace";

let view: MergeView | null = null;
let host: HTMLDivElement | null = null;

const BASE: Extension[] = [
  lineNumbers(),
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
];

function mount(
  a: string,
  b: string,
  style: { words: boolean; lines: boolean },
  ignore: "none" | "trim" | "whitespace" | "whitespaceAndLines" = "none",
): MergeView {
  host = document.createElement("div");
  document.body.appendChild(host);
  host.style.height = "400px";
  host.style.width = "900px";
  view = new MergeView({
    a: { doc: a, extensions: [...BASE, ideaDiffPane(style)] },
    b: { doc: b, extensions: [...BASE, ideaDiffPane(style)] },
    parent: host,
    gutter: false,
    highlightChanges: false,
    diffConfig: diffConfigFor(ignore),
  });
  return view;
}

/** Line classes of the pane's rendered rows. */
function lineClasses(side: "a" | "b"): string[] {
  const lines =
    view![side].contentDOM.querySelectorAll<HTMLElement>(".cm-line");
  return [...lines].map((line) => line.className);
}

/** Gutter element classes carrying a change tint. */
function gutterClasses(side: "a" | "b"): string[] {
  const cells = view![side].dom.querySelectorAll<HTMLElement>(
    ".cm-diffChangedGutter",
  );
  return [...cells].map((cell) => cell.className);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  view?.destroy();
  view = null;
  host?.remove();
  host = null;
});

describe("ideaDiffPane", () => {
  it("paints a whole replaced line as modified on both sides", () => {
    mount("one\ntwo\nthree\n", "one\nTWO\nthree\n", {
      words: true,
      lines: true,
    });
    expect(lineClasses("a")[1]).toContain("cm-diffLine-modified");
    expect(lineClasses("b")[1]).toContain("cm-diffLine-modified");
    // Unchanged lines stay unpainted.
    expect(lineClasses("a")[0]).not.toContain("cm-diffLine");
  });

  it("tints the line-number gutter with the change type", () => {
    mount("one\ntwo\nthree\n", "one\nTWO\nthree\n", {
      words: true,
      lines: true,
    });
    // Word comparison is on, so the line takes IDEA's lighter "fine" tint.
    const a = gutterClasses("a");
    const b = gutterClasses("b");
    expect(a).toHaveLength(1);
    expect(a[0]).toContain("cm-diffGutter-modified");
    expect(a[0]).toContain("cm-diffGutter-fine");
    expect(b).toHaveLength(1);
    expect(b[0]).toContain("cm-diffGutter-modified");
  });

  it("marks an inserted block on the side that has no lines", () => {
    mount("one\nthree\n", "one\ntwo\nthree\n", { words: true, lines: true });
    expect(lineClasses("b")[1]).toContain("cm-diffLine-inserted");
    // The left pane marks the boundary row, which is its second line ("three").
    expect(lineClasses("a")[1]).toContain("cm-diffLine-inserted");
    expect(lineClasses("a")[1]).toContain("cm-diffGap");
  });

  it("marks a deleted block as deleted", () => {
    mount("one\ntwo\nthree\n", "one\nthree\n", { words: true, lines: true });
    expect(lineClasses("a")[1]).toContain("cm-diffLine-deleted");
    expect(lineClasses("b")[1]).toContain("cm-diffLine-deleted");
  });

  it("highlights the changed words inside a modified line", () => {
    mount("const a = 1;\n", "const a = 2;\n", { words: true, lines: true });
    const words = view!.b.contentDOM.querySelectorAll(".cm-diffWord");
    expect(words.length).toBeGreaterThan(0);
  });

  it("'Do not highlight' leaves the pane untouched", () => {
    mount("one\ntwo\nthree\n", "one\nTWO\nthree\n", {
      words: false,
      lines: false,
    });
    expect(lineClasses("a").join(" ")).not.toContain("cm-diffLine");
    expect(gutterClasses("a")).toEqual([]);
  });

  it("ignores whitespace-only changes under the whitespace policy", () => {
    mount("a b\nc\n", "a  b\n c\n", { words: true, lines: true }, "whitespace");
    expect(lineClasses("a").join(" ")).not.toContain("cm-diffLine");
    expect(lineClasses("b").join(" ")).not.toContain("cm-diffLine");
  });
});
