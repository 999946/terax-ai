import { type Change, Chunk } from "@codemirror/merge";
import {
  type Extension,
  Prec,
  type Range,
  RangeSet,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import { GutterMarker, EditorView, gutter } from "@codemirror/view";

/**
 * Unsaved-change markers in the editor gutter: a thin colored bar to the left
 * of the line numbers for every line that differs from the last saved
 * baseline — green for added lines, orange for modified, and a red top edge on
 * the line above a deletion (VS Code's gutter indicators). Nothing is shown
 * until a baseline is set via {@link setBaselineEffect}.
 *
 * The diff between the saved baseline (document A) and the live editor
 * (document B) is maintained incrementally with `@codemirror/merge`'s
 * `Chunk` engine, so a keystroke never re-diffs the whole file.
 */

/** Which flavour of change a line carries. */
export type LineKind = "added" | "modified" | "deleted";

/** Baseline + the diff chunks (A=baseline, B=live doc). */
type ModifiedState = { base: Text | null; chunks: readonly Chunk[] };

/** Effect payload: the saved baseline text (LF-normalized, read from a ref). */
export const setBaselineEffect = StateEffect.define<{ text: string }>();

/** Turn a string into a `Text` doc, splitting on LF like the live doc is. */
export function textFromString(s: string): Text {
  // CodeMirror normalizes all line breaks to \n; the baseline is already LF
  // via useDocument's normalizeToLf, so a plain split keeps both sides aligned.
  return Text.of(s.split("\n"));
}

/** Classify a single change by its A/B spans. */
export function classifyChange(c: Change): LineKind {
  if (c.toA === c.fromA && c.fromB < c.toB) return "added"; // insert in B
  if (c.toB === c.fromB) return "deleted"; // removed from B
  return "modified"; // content replaced
}

/**
 * Map the diff chunks onto B-document line numbers. Each B line a change
 * touches gets one kind; when several changes land on the same line the
 * strongest wins (added > modified > deleted). Positions are clamped to the
 * document so EOF inserts and empty docs never throw.
 */
export function changedLines(
  chunks: readonly Chunk[],
  doc: Text,
): Map<number, LineKind> {
  const out = new Map<number, LineKind>();
  const lastLine = doc.lines;
  if (lastLine === 0) return out;
  const clamp = (p: number) => Math.max(0, Math.min(p, doc.length));
  const priority = (k: LineKind) =>
    k === "added" ? 2 : k === "modified" ? 1 : 0;
  const setLine = (pos: number, kind: LineKind) => {
    let line = doc.lineAt(clamp(pos)).number;
    if (line < 1) line = 1;
    if (line > lastLine) line = lastLine;
    const cur = out.get(line);
    if (cur === undefined || priority(kind) > priority(cur))
      out.set(line, kind);
  };
  for (const chunk of chunks) {
    for (const c of chunk.changes) {
      const fromB = clamp(chunk.fromB + c.fromB);
      const toB = clamp(chunk.fromB + c.toB);
      if (classifyChange(c) === "deleted") {
        // The removed lines take no space in B; mark the line where the gap is.
        setLine(fromB, "deleted");
      } else if (fromB < toB) {
        // added/modified occupy [fromB, toB) in B. A line is a *new line* only
        // when the insert fully contains it; anything else is an edit to an
        // existing line. (The diff is character-level, so a rewritten line may
        // surface as a pure insert.)
        const start = doc.lineAt(fromB).number;
        const end = doc.lineAt(toB - 1).number;
        for (let l = start; l <= end; l++) {
          const line = doc.line(l);
          const wholeNewLine =
            c.toA === c.fromA && line.from >= fromB && line.to <= toB;
          setLine(line.from, wholeNewLine ? "added" : "modified");
        }
      }
    }
  }
  return out;
}

const modifiedField = StateField.define<ModifiedState>({
  create: () => ({ base: null, chunks: [] }),
  update: (value, tr) => {
    // A fresh baseline wins over any diff from this transaction.
    for (const effect of tr.effects) {
      if (effect.is(setBaselineEffect)) {
        const base = textFromString(effect.value.text);
        const chunks = base.eq(tr.state.doc)
          ? []
          : Chunk.build(base, tr.state.doc);
        return { base, chunks };
      }
    }
    if (!tr.docChanged || value.base == null) return value;
    return {
      base: value.base,
      chunks: Chunk.updateB(value.chunks, value.base, tr.state.doc, tr.changes),
    };
  },
});

/** A single gutter indicator. `"spacer"` renders an invisible bar to pin width. */
class ChangeMarker extends GutterMarker {
  constructor(readonly kind: LineKind | "spacer") {
    super();
  }

  eq(other: ChangeMarker): boolean {
    return other.kind === this.kind;
  }

  toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className =
      this.kind === "spacer" ? "cm-ml-bar" : `cm-ml-bar cm-ml--${this.kind}`;
    return div;
  }
}

function buildMarkers(view: EditorView): RangeSet<GutterMarker> {
  const state = view.state.field(modifiedField, false);
  if (!state || state.base == null || state.chunks.length === 0) {
    return RangeSet.empty;
  }
  const lines = changedLines(state.chunks, view.state.doc);
  const markers: Range<GutterMarker>[] = [];
  for (const [line, kind] of lines) {
    markers.push(new ChangeMarker(kind).range(view.state.doc.line(line).from));
  }
  return RangeSet.of(markers);
}

const modifiedGutter = gutter({
  class: "cm-ml-gutter",
  markers: (view) => buildMarkers(view),
  initialSpacer: () => new ChangeMarker("spacer"),
});

const modifiedTheme = EditorView.theme({
  // A fixed-width slot left of the line numbers. The marker bar is absolutely
  // positioned, so without an explicit gutter width the slot would collapse to
  // 0 and hide the indicators. Keep both the gutter and its elements at the
  // bar's width so the coloured marks have room to render.
  ".cm-ml-gutter": {
    width: "3px",
  },
  ".cm-ml-gutter .cm-gutterElement": {
    position: "relative",
    width: "3px",
    padding: "0",
  },
  ".cm-ml-bar": {
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "0",
    width: "3px",
  },
  ".cm-ml--added": { backgroundColor: "var(--ml-added)" },
  ".cm-ml--modified": { backgroundColor: "var(--ml-modified)" },
  // Deletions take no space in B; a red top edge on the line above the gap.
  ".cm-ml--deleted": { boxShadow: "inset 0 2px 0 0 var(--ml-deleted)" },
});

/** Wire the baseline field, the change gutter, and its styling into an editor. */
export function modifiedLines(): Extension {
  return [modifiedField, Prec.highest(modifiedGutter), modifiedTheme];
}
