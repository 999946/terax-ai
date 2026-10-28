/**
 * Rendering-level test for the change/overview lanes.
 *
 * This mounts a real CodeMirror EditorView and asserts the actual DOM the
 * lanes produce — the gutter bar and the overview bands — after hunks are
 * dispatched through the modified-lines field. Pure-function tests
 * (buildLaneMarkers, marksFromHunks) can't see whether the lanes are wired
 * into the editor and render visible elements; this test locks that.
 *
 * The "next to the usual gutters" suite mounts the lanes alongside line
 * numbers, the fold gutter and the lint gutter, exactly the combination the
 * editor pane uses, so a lane hidden by gutter ordering/stacking fails here.
 */
// @vitest-environment happy-dom
import { lintGutter } from "@codemirror/lint";
import { foldGutter } from "@codemirror/language";
import { type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conflictLines } from "./conflictLines";
import { changeLane, overviewLane } from "./lanes";
import {
  modifiedLines,
  setHunksEffect,
  type GitLineHunk,
} from "./modifiedLines";

let view: EditorView | null = null;

function mount(extensions: Extension[]): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  host.style.height = "400px";
  host.style.width = "800px";
  view = new EditorView({
    doc: "a\nb\nc\nd\ne\nf\ng\n",
    parent: host,
    extensions,
  });
  return view;
}

function addedHunk(start: number, lines = 1): GitLineHunk[] {
  return [
    {
      kind: "added",
      start,
      lines,
      oldStart: 0,
      oldLines: 0,
      oldText: "",
    },
  ];
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  view?.destroy();
  view = null;
});

describe("change lane rendering (minimal)", () => {
  it("renders a gutter bar for a dispatched hunk", () => {
    const v = mount([modifiedLines(), conflictLines(), changeLane()]);
    v.dispatch({ effects: setHunksEffect.of(addedHunk(1)) });
    expect(v.dom.querySelectorAll(".cm-lane-mark").length).toBeGreaterThan(0);
  });

  it("the bar carries the added colour class", () => {
    const v = mount([modifiedLines(), conflictLines(), changeLane()]);
    v.dispatch({ effects: setHunksEffect.of(addedHunk(2)) });
    const mark = v.dom.querySelector(".cm-lane-mark");
    expect(mark!.className).toContain("cm-lane--added");
  });

  it("renders one bar per changed line", () => {
    const v = mount([modifiedLines(), conflictLines(), changeLane()]);
    v.dispatch({ effects: setHunksEffect.of(addedHunk(0, 2)) });
    expect(v.dom.querySelectorAll(".cm-lane-mark").length).toBe(2);
  });

  it("clears the bars when hunks are emptied", () => {
    const v = mount([modifiedLines(), conflictLines(), changeLane()]);
    v.dispatch({ effects: setHunksEffect.of(addedHunk(0)) });
    expect(v.dom.querySelectorAll(".cm-lane-mark").length).toBe(1);
    v.dispatch({ effects: setHunksEffect.of([]) });
    expect(v.dom.querySelectorAll(".cm-lane-mark").length).toBe(0);
  });
});

describe("change lane next to the usual gutters", () => {
  it("renders bars with line numbers, fold and lint gutters", () => {
    const v = mount([
      lineNumbers(),
      foldGutter(),
      lintGutter(),
      modifiedLines(),
      conflictLines(),
      changeLane(),
    ]);
    v.dispatch({ effects: setHunksEffect.of(addedHunk(0)) });
    expect(v.dom.querySelectorAll(".cm-lane-mark").length).toBe(1);
    // The lane gutter itself is mounted.
    expect(
      v.dom.querySelectorAll(".cm-lane .cm-gutterElement").length,
    ).toBeGreaterThan(0);
    // The mark sits inside the lane gutter's element for line 1.
    const firstLine = v.dom.querySelector(".cm-lane .cm-gutterElement");
    expect(firstLine?.querySelector(".cm-lane-mark")).toBeTruthy();
  });

  it("positions a line-4 hunk 3 lines below line 1 via margin-top", () => {
    const v = mount([
      lineNumbers(),
      foldGutter(),
      lintGutter(),
      modifiedLines(),
      conflictLines(),
      changeLane(),
    ]);
    v.dispatch({ effects: setHunksEffect.of(addedHunk(3)) });
    const laneEls = Array.from(
      v.dom.querySelectorAll(".cm-lane .cm-gutterElement"),
    );
    // CodeMirror only creates a gutter element for lines that own a mark, so a
    // bar's position is its margin-top, not an element index: line 4 sits 3
    // lines below line 1 (42px at the default 14px line height).
    const marked = laneEls.filter((el) => el.querySelector(".cm-lane-mark"));
    expect(marked.length).toBe(1);
    expect(parseFloat((marked[0] as HTMLElement).style.marginTop)).toBe(42); // 3-line gap × 14px default line height
  });
});

describe("overview lane rendering", () => {
  it("renders a band for a dispatched hunk", () => {
    const v = mount([modifiedLines(), conflictLines(), overviewLane()]);
    v.dispatch({ effects: setHunksEffect.of(addedHunk(0)) });
    const band = v.dom.querySelector(".cm-editor-overview-band");
    expect(band).toBeTruthy();
    expect(band!.className).toContain("cm-editor-overview--added");
  });

  it("positions the band container in the editor", () => {
    const v = mount([modifiedLines(), conflictLines(), overviewLane()]);
    v.dispatch({ effects: setHunksEffect.of(addedHunk(0)) });
    expect(v.dom.querySelector(".cm-editor-overview")).toBeTruthy();
  });

  it("renders bands alongside the change lane", () => {
    const v = mount([
      lineNumbers(),
      foldGutter(),
      modifiedLines(),
      conflictLines(),
      changeLane(),
      overviewLane(),
    ]);
    v.dispatch({ effects: setHunksEffect.of(addedHunk(0, 2)) });
    expect(v.dom.querySelectorAll(".cm-lane-mark").length).toBe(2);
    expect(v.dom.querySelectorAll(".cm-editor-overview-band").length).toBe(1);
  });
});
