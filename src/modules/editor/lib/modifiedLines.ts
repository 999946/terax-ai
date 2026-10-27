import { type Change, Chunk } from "@codemirror/merge";
import {
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import { conflictField } from "./conflictLines";
import {
  changeLaneMarkers,
  overviewMarks,
  type ChangeLaneMark,
  type OverviewMark,
} from "./lanes";

/**
 * Unsaved-change markers, computed by the Rust backend against the committed
 * HEAD text (see `git::line_hunks`): the backend diffs the baseline and the
 * unsaved buffer and returns structured hunks; this module only maps hunk
 * positions onto the editor. Hunk offsets are remapped through each edit with
 * `tr.changes.mapPos`, so markers stay live between refetches; the panel
 * refetches after a debounce (and on save / commit / external git changes).
 *
 * EOL skew (a CRLF-committed baseline vs the LF-normalized buffer) is handled
 * in the backend's `normalize_eol`, which used to flag every line as changed.
 */

/** Which flavour of change a line carries. */
export type LineKind = "added" | "modified" | "deleted";

/** One structured hunk from the Rust backend (camelCase, 0-based lines). */
export type GitLineHunk = {
  kind: "added" | "modified" | "deleted";
  /** 0-based first line in the current (B) document; the gap line for deletions. */
  start: number;
  /** Lines occupied in B (0 for pure deletions). */
  lines: number;
  /** 0-based first line in the baseline (HEAD). */
  oldStart: number;
  /** Baseline lines removed (0 for pure additions). */
  oldLines: number;
  /** The removed source text (popup / rollback). */
  oldText: string;
};

/** Effect payload: a fresh set of hunks computed by the backend. */
export const setHunksEffect = StateEffect.define<GitLineHunk[]>();

/** The state holds hunks with document offsets mapped through edits. */
type ModifiedState = { hunks: EditorHunk[] };

/** A hunk with its extent as document offsets (live, mapped through edits). */
export type EditorHunk = GitLineHunk & { from: number; to: number };

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
 *
 * Used by the diff panes (`GitDiffPane`/`AiDiffPane`), which diff two editor
 * docs via `@codemirror/merge`; the editor's own change lane uses backend
 * hunks instead (see {@link toEditorHunks}).
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

/** Line-start offsets of the live document, for mapping 0-based lines → offset.
 * `starts[i]` is the document offset of line `i+1` (0-based index), and
 * `starts[doc.lines]` is the end of the document, so `to` for a hunk landing
 * on the last line maps to `doc.length`. */
function lineStarts(doc: Text): number[] {
  const starts = new Array<number>(doc.lines + 1);
  for (let i = 0; i < doc.lines; i++) starts[i] = doc.line(i + 1).from;
  starts[doc.lines] = doc.length;
  return starts;
}

/** Convert backend hunks (0-based B lines) into offset-based editor hunks. */
export function toEditorHunks(
  hunks: readonly GitLineHunk[],
  doc: Text,
): EditorHunk[] {
  const starts = lineStarts(doc);
  const at = (line: number) => starts[Math.min(line, starts.length - 1)]!;
  return hunks.map((h) => ({
    ...h,
    from: at(h.start),
    to: h.lines === 0 ? at(h.start) : at(h.start + h.lines),
  }));
}

export const modifiedField = StateField.define<ModifiedState>({
  create: () => ({ hunks: [] }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setHunksEffect)) {
        return { hunks: toEditorHunks(effect.value, tr.state.doc) };
      }
    }
    if (!tr.docChanged || value.hunks.length === 0) return value;
    // Remap every hunk's offsets through the edit. mapPos clamps to the new
    // document; a hunk whose `to` is pushed to the end collapses to its "from"
    // (a 0-length hunk), which the debounced refetch realigns.
    const hunks = value.hunks.map((h) => {
      const from = tr.changes.mapPos(h.from, -1);
      const to = Math.max(
        from,
        tr.changes.mapPos(h.to, h.to === h.from ? -1 : 1),
      );
      return { ...h, from, to };
    });
    return { hunks };
  },
});

export function editorHunks(state: EditorState): EditorHunk[] {
  return state.field(modifiedField, false)?.hunks ?? [];
}

/** The lane bars for a set of editor hunks: one per B line a hunk touches. */
export function marksFromHunks(
  hunks: readonly EditorHunk[],
  doc: Text,
): ChangeLaneMark[] {
  const out: ChangeLaneMark[] = [];
  for (const h of hunks) {
    if (h.kind === "deleted" || h.to <= h.from) {
      const pos = Math.min(h.from, doc.length);
      out.push({ line: doc.lineAt(pos).number, color: h.kind });
      continue;
    }
    const first = doc.lineAt(h.from).number;
    const last = doc.lineAt(Math.max(h.from, h.to - 1)).number;
    for (let n = first; n <= last; n++) out.push({ line: n, color: h.kind });
  }
  return out;
}

/** Overview bands from editor hunks (document offsets). The overview is a
 * two-colour strip (added=green / deleted=red); modified lines show green. */
export function overviewFromHunks(
  hunks: readonly EditorHunk[],
  doc: Text,
): OverviewMark[] {
  const bands: OverviewMark[] = [];
  for (const h of hunks) {
    if (h.kind === "deleted" || h.to <= h.from) {
      const pos = Math.min(h.from, doc.length);
      bands.push({ from: pos, to: pos, color: "deleted" });
    } else {
      bands.push({ from: h.from, to: h.to - 1, color: "added" });
    }
  }
  return bands;
}

/** Turn editor hunks + conflict marks into change-lane bars (1-based lines). */
export function changeLaneFromState(
  state: ModifiedState | null | undefined,
  conflict: ReadonlyMap<number, string> | null | undefined,
  doc: Text,
): ChangeLaneMark[] {
  const marks = marksFromHunks(state?.hunks ?? [], doc);
  if (conflict) {
    const conflictLines = new Set(conflict.keys());
    // A conflict wins over any change hunk on the same line: drop the hunk
    // mark first, then contribute the conflict bar (single marker per line).
    const kept = marks.filter((m) => !conflictLines.has(m.line));
    for (const line of conflictLines) kept.push({ line, color: "conflict" });
    return kept;
  }
  return marks;
}

/** Turn editor hunks + conflict marks into overview bands. */
export function overviewFromState(
  state: ModifiedState | null | undefined,
  conflict: ReadonlyMap<number, string> | null | undefined,
  doc: Text,
): OverviewMark[] {
  const bands = overviewFromHunks(state?.hunks ?? [], doc);
  if (conflict) {
    for (const line of conflict.keys()) {
      bands.push({
        from: doc.line(line).from,
        to: doc.line(line).to,
        color: "deleted",
      });
    }
  }
  return bands;
}

/**
 * Wire the hunk field into the shared lanes. The field holds the backend
 * hunks remapped through edits; providers feed the lanes from it.
 */
export function modifiedLines(): Extension {
  return [
    modifiedField,
    changeLaneMarkers.compute([modifiedField, conflictField], (s) =>
      changeLaneFromState(
        s.field(modifiedField, false),
        s.field(conflictField, false),
        s.doc,
      ),
    ),
    overviewMarks.compute([modifiedField, conflictField], (s) =>
      overviewFromState(
        s.field(modifiedField, false),
        s.field(conflictField, false),
        s.doc,
      ),
    ),
  ];
}
