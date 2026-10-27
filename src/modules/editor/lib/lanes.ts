import {
  type Extension,
  Facet,
  Prec,
  type Range,
  RangeSet,
  type Text,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  type ViewUpdate,
  ViewPlugin,
  gutter,
} from "@codemirror/view";

/**
 * Shared editor lanes: the left change lane (thin 3px bars next to line
 * numbers) and the overview lane (coloured bands, click to jump). Features
 * contribute plain data into the facets below; the lanes own the single
 * gutter / overlay and its rendering, so any number of indicators share one
 * column instead of stacking gutters.
 *
 * Marks are document offsets (for the overview) or 1-based lines (for the
 * change lane), so editing remaps them through the normal facet recompute
 * path. Providers are layered in contribution order; `buildLaneMarkers`
 * resolves overlaps within the lane (conflict beats change kinds).
 */

/** A 3px change-lane bar on one line. */
export type ChangeLaneMark = {
  /** 1-based line in the live document. */
  line: number;
  color: LaneColor;
};

/** The colours the change lane can show. */
export type LaneColor = "added" | "modified" | "deleted" | "conflict";

/** Change-lane bars contributed by every feature, flattened in order. */
export const changeLaneMarkers = Facet.define<
  ChangeLaneMark[],
  ChangeLaneMark[]
>({
  combine: (values) => values.flat(),
});

/** A coloured band on the overview lane. Offsets are document coordinates. */
export type OverviewMark = {
  /** Document offset where the band starts. */
  from: number;
  /** Inclusive end offset; a point mark when omitted. */
  to?: number;
  color: "added" | "deleted";
  /** Shown on hover. */
  title?: string;
};

/** Overview bands contributed by every feature, flattened in order. */
export const overviewMarks = Facet.define<OverviewMark[], OverviewMark[]>({
  combine: (values) => values.flat(),
});

/** A 3px bar in the change lane. */
class LaneMarker extends GutterMarker {
  constructor(readonly color: LaneColor) {
    super();
  }

  override eq(other: GutterMarker): boolean {
    return other instanceof LaneMarker && other.color === this.color;
  }

  override toDOM(): HTMLElement {
    const div = document.createElement("div");
    div.className = `cm-lane-mark cm-lane--${this.color}`;
    return div;
  }
}

const LANE_PRIORITY: Record<LaneColor, number> = {
  conflict: 4,
  added: 3,
  modified: 2,
  deleted: 1,
};

/**
 * Merge every contributed bar into one marker per line, clamped to the
 * document. One line renders once; the strongest colour wins (conflict >
 * added > modified > deleted).
 */
export function buildLaneMarkers(
  marks: readonly ChangeLaneMark[],
  doc: Text,
): RangeSet<GutterMarker> {
  if (marks.length === 0 || doc.lines === 0) return RangeSet.empty;
  const best = new Map<number, LaneColor>();
  for (const mark of marks) {
    const line = Math.max(1, Math.min(mark.line, doc.lines));
    const prev = best.get(line);
    if (prev === undefined || LANE_PRIORITY[mark.color] > LANE_PRIORITY[prev])
      best.set(line, mark.color);
  }
  const lines = [...best.keys()].sort((a, b) => a - b);
  const markers: Range<GutterMarker>[] = [];
  for (const line of lines) {
    markers.push(new LaneMarker(best.get(line)!).range(doc.line(line).from));
  }
  return RangeSet.of(markers);
}

const laneTheme = EditorView.theme({
  ".cm-lane": {
    width: "3px",
  },
  ".cm-lane .cm-gutterElement": {
    position: "relative",
    width: "3px",
    padding: "0",
  },
  ".cm-lane-mark": {
    position: "absolute",
    top: "0",
    bottom: "0",
    left: "0",
    width: "3px",
  },
  ".cm-lane--added": { backgroundColor: "var(--ml-added)" },
  ".cm-lane--modified": { backgroundColor: "var(--ml-modified)" },
  // Deletions take no space in the live doc; a red top edge on the gap line.
  ".cm-lane--deleted": { boxShadow: "inset 0 2px 0 0 var(--ml-deleted)" },
  ".cm-lane--conflict": { backgroundColor: "var(--ml-conflict)" },
});

/**
 * The single 3px change lane next to the line numbers. Reads
 * {@link changeLaneMarkers}; every indicator rides this one gutter.
 */
export function changeLane(): Extension {
  return [
    Prec.highest(
      gutter({
        class: "cm-lane",
        markers: (view) =>
          buildLaneMarkers(view.state.facet(changeLaneMarkers), view.state.doc),
      }),
    ),
    laneTheme,
  ];
}

const MIN_BAND_PERCENT = 0.4;

/** The band whose span sits closest to `line`; its center is the jump target. */
function nearestBandCenter(
  marks: readonly { from: number; to: number }[],
  line: number,
): number | null {
  if (marks.length === 0 || line < 1) return null;
  let best = marks[0];
  let bestDist = Infinity;
  for (const m of marks) {
    const dist = line < m.from ? m.from - line : line > m.to ? line - m.to : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
  }
  return Math.round((best.from + best.to) / 2);
}

/**
 * The overview lane (a thin colour strip on the editor edge), rendered from
 * {@link overviewMarks}. Bands are positioned by logical line ratio; clicking
 * a band scrolls the editor to that change.
 */
class OverviewLane {
  private readonly dom: HTMLDivElement;
  private marks: OverviewMark[] = [];

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-editor-overview";
    this.dom.setAttribute("role", "img");
    this.dom.setAttribute("aria-label", "Git changes overview");
    this.dom.addEventListener("mousedown", this.onMouseDown);
    view.dom.appendChild(this.dom);
    this.draw();
  }

  update(update: ViewUpdate) {
    // Redraw only when the contributed bands changed.
    if (
      update.startState.facet(overviewMarks) !==
      update.state.facet(overviewMarks)
    )
      this.draw();
  }

  private draw() {
    const view = this.view;
    const doc = view.state.doc;
    const totalLines = doc.lines;
    this.marks = view.state.facet(overviewMarks);
    this.dom.textContent = "";
    if (totalLines < 1 || this.marks.length === 0) return;
    for (const m of this.marks) {
      const fromPos = Math.min(Math.max(0, m.from), doc.length);
      const toPos =
        m.to == null ? fromPos : Math.min(Math.max(fromPos, m.to), doc.length);
      const topLine = doc.lineAt(fromPos).number;
      const bottomLine = doc.lineAt(toPos).number;
      const top = ((topLine - 1) / totalLines) * 100;
      const height = Math.max(
        ((bottomLine - topLine + 1) / totalLines) * 100,
        MIN_BAND_PERCENT,
      );
      const band = document.createElement("div");
      band.className =
        m.color === "added"
          ? "cm-editor-overview-band cm-editor-overview--added"
          : "cm-editor-overview-band cm-editor-overview--deleted";
      band.style.top = `${top}%`;
      band.style.height = `${height}%`;
      if (m.title) band.title = m.title;
      this.dom.appendChild(band);
    }
  }

  private lineRanges(view: EditorView): { from: number; to: number }[] {
    const doc = view.state.doc;
    const len = doc.length;
    return this.marks.map((m) => {
      const fromPos = Math.min(Math.max(0, m.from), len);
      const toPos =
        m.to == null ? fromPos : Math.min(Math.max(fromPos, m.to), len);
      return { from: doc.lineAt(fromPos).number, to: doc.lineAt(toPos).number };
    });
  }

  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const view = this.view;
    const rect = this.dom.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = (e.clientY - rect.top) / rect.height;
    const totalLines = view.state.doc.lines;
    const line = Math.max(
      1,
      Math.min(totalLines, Math.round(ratio * totalLines)),
    );
    const target = nearestBandCenter(this.lineRanges(view), line);
    if (target === null) return;
    const pos = view.state.doc.line(
      Math.max(1, Math.min(target, totalLines)),
    ).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
  };

  destroy() {
    this.dom.remove();
  }
}

const overviewTheme = EditorView.theme({
  ".cm-editor-overview": {
    position: "absolute",
    top: "0",
    left: "1px",
    bottom: "0",
    width: "6px",
    zIndex: 20,
    cursor: "pointer",
  },
  ".cm-editor-overview-band": {
    position: "absolute",
    left: "0",
    width: "100%",
  },
  ".cm-editor-overview--added": {
    backgroundColor: "var(--ml-added)",
  },
  ".cm-editor-overview--deleted": {
    backgroundColor: "var(--ml-deleted)",
  },
});

/** The overview lane view plugin. Reads {@link overviewMarks}. */
export function overviewLane(): Extension {
  return [ViewPlugin.fromClass(OverviewLane), overviewTheme];
}
