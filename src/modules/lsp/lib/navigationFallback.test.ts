// @vitest-environment happy-dom
import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  declarationSummary,
  hoverText,
  identifierAt,
  isSelfTarget,
  syntaxDeclarations,
} from "./client";

const views: EditorView[] = [];

function viewFor(doc: string): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [javascript()] }),
  });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe("identifierAt", () => {
  it("returns the word under the position", () => {
    const view = viewFor("const answer = compute();");
    const pos = view.state.doc.toString().indexOf("compute") + 2;
    expect(identifierAt(view, pos)).toMatchObject({ name: "compute" });
  });

  it("returns null on whitespace", () => {
    const view = viewFor("x   y");
    expect(identifierAt(view, 2)).toBeNull();
  });
});

describe("syntaxDeclarations", () => {
  it("finds the declaration of a reference in the same file", () => {
    const view = viewFor("function greet() {}\ngreet();");
    const targets = syntaxDeclarations(view, "greet");
    expect(targets.length).toBeGreaterThan(0);
    const first = targets[0];
    expect(view.state.doc.sliceString(first.from, first.to)).toBe("greet");
  });

  it("ignores identifiers that are not declarations", () => {
    const view = viewFor("const value = other; other();");
    expect(syntaxDeclarations(view, "other")).toEqual([]);
  });

  it("does not report a declaration of an unrelated name", () => {
    const view = viewFor("function a() {}\nfunction b() {}");
    const targets = syntaxDeclarations(view, "missing");
    expect(targets).toEqual([]);
  });
});

describe("isSelfTarget", () => {
  it("detects a position inside one of the targets", () => {
    expect(isSelfTarget(5, [{ from: 4, to: 9 }])).toBe(true);
  });

  it("returns false outside every target", () => {
    expect(isSelfTarget(20, [{ from: 4, to: 9 }])).toBe(false);
  });
});

describe("hoverText", () => {
  it("flattens markdown and plaintext contents", () => {
    expect(
      hoverText({
        contents: [
          { kind: "markdown", value: "```ts\nconst a = 1\n```" },
          "plain",
        ],
      }),
    ).toBe("```ts\nconst a = 1\n```\n\nplain");
  });

  it("returns null for empty contents", () => {
    expect(hoverText(null)).toBeNull();
    expect(hoverText({ contents: [] })).toBeNull();
    expect(hoverText({ contents: "   " })).toBeNull();
  });
});

describe("declarationSummary", () => {
  it("keeps only the first non-empty line", () => {
    expect(declarationSummary("\n\nfunction greet(): void\n")).toBe(
      "function greet(): void",
    );
  });

  it("truncates very long lines", () => {
    expect(declarationSummary("x".repeat(400))).toHaveLength(300);
  });
});
