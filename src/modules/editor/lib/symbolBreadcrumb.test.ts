import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { javascript } from "@codemirror/lang-javascript";
import { computeSymbolBreadcrumb } from "./symbolBreadcrumb";

function makeJsState(doc: string, cursorAt: number): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: cursorAt },
    extensions: [javascript()],
  });
}

const jsLang = { id: "js" };

describe("computeSymbolBreadcrumb", () => {
  it("returns null for an empty document", () => {
    const state = makeJsState("", 0);
    expect(computeSymbolBreadcrumb(state, jsLang)).toBeNull();
  });

  it("returns null when the language is unresolved / oversized", () => {
    const state = makeJsState("function f() { const x = 1; }", 5);
    expect(computeSymbolBreadcrumb(state, { id: null })).toBeNull();
  });

  it("returns the enclosing function chain for a cursor inside a function", () => {
    const doc = [
      "function outer() {",
      "  function inner() {",
      "    const x = 1;",
      "  }",
      "}",
    ].join("\n");
    // Cursor on the `x = 1;` line.
    const state = makeJsState(
      doc,
      "function outer() {\n  function inner() {\n    ".length,
    );
    const segs = computeSymbolBreadcrumb(state, jsLang);
    expect(segs?.map((s) => s.label)).toEqual(["outer", "inner"]);
  });

  it("returns class + method levels for a cursor inside a class method", () => {
    const doc = [
      "class Box {",
      "  constructor(w) { this.w = w; }",
      "  area() {",
      "    return this.w * this.w;",
      "  }",
      "}",
    ].join("\n");
    const state = makeJsState(doc, doc.indexOf("return this.w"));
    const segs = computeSymbolBreadcrumb(state, jsLang);
    const labels = segs?.map((s) => s.label) ?? [];
    expect(labels).toContain("Box");
    expect(labels[labels.length - 1]).toBe("area");
  });

  it("includes only symbols on the ancestor chain, not sibling statements", () => {
    const doc = [
      "function alpha() {",
      "  const a = 1;",
      "  function beta() {",
      "    const b = 2;",
      "  }",
      "}",
    ].join("\n");
    // Cursor inside `beta`'s body — `a = 1` (alpha's statement) must not appear.
    const cursor = doc.indexOf("const b");
    const state = makeJsState(doc, cursor);
    const labels =
      computeSymbolBreadcrumb(state, jsLang)?.map((s) => s.label) ?? [];
    expect(labels).toEqual(["alpha", "beta"]);
    expect(labels).not.toContain("a");
  });

  it("provides jump positions at the declaration-name tokens", () => {
    const doc = ["function foo() {", "}"].join("\n");
    const cursor = doc.indexOf("}");
    const state = makeJsState(doc, Math.max(0, cursor));
    const segs = computeSymbolBreadcrumb(state, jsLang);
    expect(segs).not.toBeNull();
    const at = segs![0];
    expect(doc.slice(at.from, at.from + at.label.length)).toBe("foo");
  });
});
