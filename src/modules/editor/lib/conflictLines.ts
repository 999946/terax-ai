import {
  type Extension,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Merge-conflict markers in the editor gutter. A red bar covers every line
 * inside an unmerged `<<<<<<<` … `>>>>>>>` region (including the `=======`
 * separator), so a file left mid-merge is visually obvious.
 *
 * Unlike {@link import("./modifiedLines")} which diffs against a git baseline,
 * conflict detection reads the *live document* text directly — a conflict is a
 * textual pattern, not a git state. The field is (re)built on file load via
 * {@link setConflictEffect} and rescanned on edits while markers are present.
 */

export type ConflictMark = "conflict";

/**
 * Pure: find all lines that fall inside a merge-conflict region. Returns a map
 * of 1-based line number → `"conflict"`. A `<<<<<<<` opens a region, `>>>>>>>`
 * closes it (all lines in between, inclusive, are marked); an unclosed marker
 * extends to the end of the document. A stray `=======` outside a region is
 * ignored.
 */
export function conflictRanges(text: string): Map<number, ConflictMark> {
  const out = new Map<number, ConflictMark>();
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (start < 0) {
      if (l.startsWith("<<<<<<<")) start = i;
    } else if (l.startsWith(">>>>>>>")) {
      for (let k = start; k <= i; k++) out.set(k + 1, "conflict");
      start = -1;
    }
  }
  if (start >= 0) {
    for (let k = start; k < lines.length; k++) out.set(k + 1, "conflict");
  }
  return out;
}

/** Effect payload: the document text to scan (sent on file load). */
export const setConflictEffect = StateEffect.define<{ text: string }>();

/** Whether any line near the changed ranges starts with a conflict marker. */
function changesTouchMarkerLine(tr: Transaction): boolean {
  const doc = tr.state.doc;
  const seen = new Set<number>();
  let touched = false;
  tr.changes.iterChangedRanges((fromB, toB) => {
    const from = Math.max(0, fromB);
    const to = Math.min(doc.length, toB);
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to > 0 ? to - 1 : 0).number;
    for (let ln = first - 1; ln <= last + 1; ln++) {
      if (ln < 1 || ln > doc.lines || seen.has(ln)) continue;
      seen.add(ln);
      const line = doc.line(ln);
      if (line.length === 0) continue;
      const t = doc.sliceString(line.from, line.to);
      if (t.startsWith("<<<<<<<") || t.startsWith(">>>>>>>")) touched = true;
    }
  });
  return touched;
}

const conflictField = StateField.define<Map<number, ConflictMark>>({
  create: () => new Map(),
  update: (value, tr) => {
    // A fresh scan (on file load) always wins.
    for (const effect of tr.effects) {
      if (effect.is(setConflictEffect))
        return conflictRanges(effect.value.text);
    }
    if (!tr.docChanged) return value;
    // Fast path: nothing is marked and the edit didn't touch a marker line —
    // keep the empty map without scanning the whole doc.
    if (value.size === 0 && !changesTouchMarkerLine(tr)) return value;
    return conflictRanges(tr.state.doc.toString());
  },
});

/** Per-line conflict indicator colour. */
const conflictTheme = EditorView.theme({
  // Base bar geometry (shared with the change-indicator bar) so this theme is
  // self-contained even if the modified-lines gutter were absent.
  ".cm-ml-bar": {
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "0",
    width: "3px",
  },
  ".cm-ml--conflict": { backgroundColor: "var(--ml-conflict)" },
});

/**
 * Wire the conflict field and its styling into an editor. The gutter itself is
 * provided by `modifiedLines()`; the conflict marks are rendered there so a
 * conflicted file keeps a single indicator column (no extra gutter width).
 */
export function conflictLines(): Extension {
  return [conflictField, conflictTheme];
}

export { conflictField };
