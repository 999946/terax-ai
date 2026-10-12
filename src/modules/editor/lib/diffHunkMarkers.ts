import type { GitHunk } from "@/modules/ai/lib/native";
import {
  type Extension,
  Prec,
  type Range,
  RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import type { LineKind } from "./modifiedLines";

/**
 * Hunk anchor lines and diff-overview marks for the git diff pane.
 *
 * Anchors map each worktree diff hunk onto a single line of the modified (B)
 * document, where the checkbox column renders one checkbox per hunk. The
 * overview marks squash per-line change kinds into contiguous bands for the
 * right-edge ruler.
 */

/** One hunk's checkbox anchor on the modified (B) side. */
export type HunkAnchor = { index: number; line: number };

/** A contiguous band of changed lines for the overview ruler. */
export type RulerMark = { from: number; to: number; kind: "add" | "del" };

/**
 * Map each hunk to the B-side line that anchors its checkbox. A hunk's
 * `newStart`/`newCount` describe the modified file, where `newCount` counts
 * context + added lines (deleted lines take no room in B). The head of that
 * range (always the first hunk line, deletion-only hunks anchor on the line
 * above the gap) is where the checkbox goes. Lines are clamped to the document
 * so empty docs and EOF inserts never throw.
 */
export function hunkAnchorLines(
  hunks: readonly GitHunk[],
  docLines: number,
): HunkAnchor[] {
  const out: HunkAnchor[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const start = hunks[i].newStart;
    const line = Math.max(1, Math.min(start, Math.max(docLines, 1)));
    out.push({ index: i, line });
  }
  return out;
}

/** True when the change kind renders as an addition band on the right ruler. */
function isAddKind(kind: LineKind): boolean {
  return kind !== "deleted";
}

/**
 * Squash a per-line change map (B line -> kind) into contiguous bands, sorted
 * by line. A deletion only takes a red mark at the line where the gap sits.
 * Returned bands are clamped to `[1, totalLines]`; an empty map yields [].
 */
export function rulerMarks(
  changed: ReadonlyMap<number, LineKind>,
  totalLines: number,
): RulerMark[] {
  if (totalLines < 1 || changed.size === 0) return [];
  const lines = [...changed.keys()].sort((a, b) => a - b);
  const out: RulerMark[] = [];
  let open: RulerMark | null = null;
  for (const line of lines) {
    const kind = changed.get(line);
    if (kind === undefined) continue;
    const markKind: "add" | "del" = isAddKind(kind) ? "add" : "del";
    if (open && open.kind === markKind && line === open.to + 1) {
      open.to = line;
      continue;
    }
    if (open) out.push(open);
    open = { from: line, to: line, kind: markKind };
  }
  if (open) out.push(open);
  for (const m of out) {
    m.from = Math.max(1, Math.min(m.from, totalLines));
    m.to = Math.min(totalLines, Math.max(m.to, 1));
  }
  return out;
}

/** Effect payload: the parsed worktree hunks of the diff the editor shows. */
export const setHunksEffect = StateEffect.define<GitHunk[]>();

/** Holds the parsed hunks so the checkbox gutter can derive anchors. */
const hunkField = StateField.define<GitHunk[]>({
  create: () => [],
  update: (value, tr) => {
    for (const effect of tr.effects) {
      if (effect.is(setHunksEffect)) return effect.value;
    }
    return value;
  },
});

/** The localized labels the checkbox carries as its title / aria-label. */
export type HunkCheckLabels = { stage: string; unstage: string };

/** A single checkbox marker. `index` is the hunk's position in the array. */
class HunkCheckMarker extends GutterMarker {
  constructor(
    readonly index: number,
    readonly label: string,
  ) {
    super();
  }

  eq(other: HunkCheckMarker): boolean {
    return other.index === this.index && other.label === this.label;
  }

  toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-hunk-check";
    div.dataset.hunkIdx = String(this.index);
    div.title = this.label;
    div.setAttribute("role", "checkbox");
    div.setAttribute("aria-checked", "false");
    div.setAttribute("aria-label", this.label);
    return div;
  }
}

/** Invisible bar that pins the checkbox gutter's width. */
class HunkCheckSpacer extends GutterMarker {
  eq(other: HunkCheckSpacer): boolean {
    return other instanceof HunkCheckSpacer;
  }

  toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = "cm-hunk-check cm-hunk-check-spacer";
    return div;
  }
}

function buildCheckMarkers(
  view: EditorView,
  labels: HunkCheckLabels,
  staged: boolean,
): RangeSet<GutterMarker> {
  const hunks = view.state.field(hunkField, false);
  if (!hunks || hunks.length === 0) return RangeSet.empty;
  const docLines = view.state.doc.lines;
  const anchors = hunkAnchorLines(hunks, docLines);
  const label = staged ? labels.unstage : labels.stage;
  const markers: Range<GutterMarker>[] = [];
  for (const { index, line } of anchors) {
    markers.push(
      new HunkCheckMarker(index, label).range(view.state.doc.line(line).from),
    );
  }
  return RangeSet.of(markers);
}

const hunkCheckTheme = EditorView.theme({
  ".cm-hunk-check-gutter": {
    width: "16px",
  },
  ".cm-hunk-check-gutter .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
  },
  ".cm-hunk-check": {
    width: "10px",
    height: "10px",
    borderRadius: "2px",
    border: "1px solid var(--muted-foreground, #9ca3af)",
    boxSizing: "border-box",
    cursor: "pointer",
    opacity: 0.55,
  },
  ".cm-hunk-check:hover": {
    opacity: 1,
    borderColor: "var(--foreground, #16171a)",
  },
  ".cm-hunk-check-spacer": {
    visibility: "hidden",
    pointerEvents: "none",
  },
});

/**
 * One checkbox per hunk, rendered at the hunk's anchor line on the side before
 * the content. Which gutter each diff mode wires it into decides the side and
 * column: the split view mounts it only on the modified (right) editor, so the
 * boxes line up with the right-hand file's line numbers. `staged` picks the
 * unstage label for a `+` diff (checking removes a hunk from the index).
 */
export function hunkCheckGutter(
  labels: HunkCheckLabels,
  staged: boolean,
): Extension {
  const spec = gutter({
    class: "cm-hunk-check-gutter",
    markers: (view) => buildCheckMarkers(view, labels, staged),
    initialSpacer: () => new HunkCheckSpacer(),
  });
  return [Prec.high(spec), hunkField, hunkCheckTheme];
}
