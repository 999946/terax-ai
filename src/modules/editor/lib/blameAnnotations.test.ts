// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitBlameEntry } from "@/modules/ai/lib/native";
import { setBlameEffect } from "./blameBadge";
import {
  blameAnnotationsCompartment,
  blameAnnotationsExtension,
} from "./blameAnnotations";

let view: EditorView | null = null;

const entry = (line: number, sha = `s${line}`): GitBlameEntry => ({
  line,
  sha,
  shortSha: sha.slice(0, 7),
  author: `Author ${line}`,
  authorEmail: `a${line}@x.io`,
  timestampSecs: 0,
  subject: `Subject ${line}`,
});

function mount(): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    doc: "a\nb\nc\nd\n",
    parent: host,
    extensions: [blameAnnotationsCompartment.of([])],
  });
  return view;
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  view?.destroy();
  view = null;
});

describe("blame annotations toggle (rendering)", () => {
  it("shows no gutter initially", () => {
    const v = mount();
    expect(v.dom.querySelector(".cm-blame-annotations")).toBeNull();
  });

  it("renders one annotation per committed line after enabling", () => {
    const v = mount();
    v.dispatch({
      effects: blameAnnotationsCompartment.reconfigure(
        blameAnnotationsExtension(),
      ),
    });
    v.dispatch({
      effects: setBlameEffect.of(
        new Map([
          [1, entry(1)],
          [2, entry(2)],
          [3, entry(3)],
        ]),
      ),
    });
    const marks = v.dom.querySelectorAll(
      ".cm-blame-annotations .cm-blame-annotation",
    );
    // Lines 1-3 committed; line 4 (new, uncommitted) and the trailing empty
    // line render empty marker cells.
    expect(marks.length).toBe(5);
    expect(marks[3]?.textContent?.trim()).toBe("");
    expect(marks[0]?.textContent).toContain("Author");
    expect(marks[1]?.textContent).toContain("Author");
  });

  it("disables back to no gutter", () => {
    const v = mount();
    v.dispatch({
      effects: blameAnnotationsCompartment.reconfigure(
        blameAnnotationsExtension(),
      ),
    });
    v.dispatch({ effects: setBlameEffect.of(new Map([[1, entry(1)]])) });
    expect(v.dom.querySelector(".cm-blame-annotations")).not.toBeNull();
    v.dispatch({ effects: blameAnnotationsCompartment.reconfigure([]) });
    expect(v.dom.querySelector(".cm-blame-annotations")).toBeNull();
  });
});

describe("blame annotations line tracking through edits", () => {
  it("moves the annotation when a line is inserted above", () => {
    const v = mount();
    v.dispatch({
      effects: blameAnnotationsCompartment.reconfigure(
        blameAnnotationsExtension(),
      ),
    });
    v.dispatch({
      effects: setBlameEffect.of(
        new Map([
          [1, entry(1, "a1")],
          [2, entry(2, "a2")],
        ]),
      ),
    });

    // Insert a new first line.
    v.dispatch({ changes: { from: 0, insert: "X\n" } });

    // The annotation that belonged to disk line 1 now rides doc line 2.
    const marks = v.dom.querySelectorAll(
      ".cm-blame-annotations .cm-blame-annotation",
    );
    // First line is uncommitted (empty), second holds a1.
    expect(marks[0]?.textContent?.trim()).toBe("");
    expect(marks[1]?.textContent).toContain("Author");
  });
});
