import { indentUnit } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { computeEditorStatus, type EditorStatusExtra } from "./editorStatus";

function makeState(doc: string, cursorAt: number): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: cursorAt },
    extensions: [indentUnit.of("    ")],
  });
}

const extra: EditorStatusExtra = {
  eol: "\n",
  language: "TypeScript",
  readonly: false,
  dirty: false,
};

describe("computeEditorStatus", () => {
  it("reports the 1-based line and column of the cursor", () => {
    // "line one\nsecond" — place cursor at 's' of "second" (index 9).
    const state = makeState("line one\nsecond", 9);
    const s = computeEditorStatus(state, extra);
    expect(s.line).toBe(2);
    expect(s.col).toBe(1);
  });

  it("resolves column relative to its line, not the document", () => {
    // cursor at index 3 of "abc\nxyz" → line 1, col 4.
    const state = makeState("abc\nxyz", 3);
    expect(computeEditorStatus(state, extra)).toMatchObject({
      line: 1,
      col: 4,
    });
  });

  it("reads the document indent unit from the facet", () => {
    const state = makeState("a\nb", 0);
    expect(computeEditorStatus(state, extra).indentUnit).toBe("    ");
  });

  it("passes through EOL, language, readonly and dirty flags", () => {
    const state = makeState("a\nb", 0);
    const s = computeEditorStatus(state, {
      ...extra,
      eol: "\r\n",
      language: "Rust",
      readonly: true,
      dirty: true,
    });
    expect(s.eol).toBe("\r\n");
    expect(s.language).toBe("Rust");
    expect(s.readonly).toBe(true);
    expect(s.dirty).toBe(true);
  });
});
