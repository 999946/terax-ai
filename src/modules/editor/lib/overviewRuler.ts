import { type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { conflictField } from "./conflictLines";
import { rulerMarks, type RulerMark } from "./diffHunkMarkers";
import {
  changedLines,
  modifiedField,
  setBaselineEffect,
} from "./modifiedLines";

/**
 * Right-edge change overview for the file editor, matching the git diff pane's
 * DiffOverview: additions and modifications fold into contiguous green bands,
 * deletions into red, positioned by logical line ratio, so a glance shows how
 * much of the file diverges and where. Clicking a band scrolls the editor to
 * that change.
 *
 * It reuses the exact same baseline-vs-live diff the left gutter renders (the
 * shared `modifiedField`), plus the conflict field — conflicts show as red like
 * deletions — so the two indicators always agree. Files without a git baseline
 * (non-repo or over the large-file guard) render neither.
 */

const MIN_BAND_PERCENT = 0.4;

/** The band whose span sits closest to `line`; its center is the jump target. */
function nearestBandCenter(marks: RulerMark[], line: number): number | null {
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

class OverviewRuler {
  private readonly dom: HTMLDivElement;
  private marks: RulerMark[] = [];

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
    // Redraw only when the underlying diff could have changed: an edit (Chunk
    // update) or a fresh baseline (its effect carries a new committed text).
    if (
      update.docChanged ||
      update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setBaselineEffect)),
      )
    ) {
      this.draw();
    }
  }

  private draw() {
    const view = this.view;
    const field = view.state.field(modifiedField, false);
    const totalLines = view.state.doc.lines;
    let marks: RulerMark[] = [];
    if (
      field &&
      field.base != null &&
      field.chunks.length > 0 &&
      totalLines > 0
    ) {
      const changed = changedLines(field.chunks, view.state.doc);
      // Merge conflicts sit mid-file with no git diff of their own; surface
      // them as red bands like deletions.
      const conflict = view.state.field(conflictField, false);
      if (conflict) {
        for (const [line] of conflict) changed.set(line, "deleted");
      }
      marks = rulerMarks(changed, totalLines);
    }
    this.marks = marks;
    this.dom.textContent = "";
    for (const m of marks) {
      const band = document.createElement("div");
      band.className =
        m.kind === "add"
          ? "cm-editor-overview-band cm-editor-overview--added"
          : "cm-editor-overview-band cm-editor-overview--deleted";
      band.style.top = `${((m.from - 1) / totalLines) * 100}%`;
      band.style.height = `${Math.max(
        ((m.to - m.from + 1) / totalLines) * 100,
        MIN_BAND_PERCENT,
      )}%`;
      this.dom.appendChild(band);
    }
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
    const target = nearestBandCenter(this.marks, line);
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

const overviewPlugin = ViewPlugin.fromClass(OverviewRuler);

const overviewTheme = EditorView.theme({
  ".cm-editor-overview": {
    position: "absolute",
    top: "0",
    right: "1px",
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

/** Show a diff-pane-style change overview at the editor's right edge. */
export function overviewRuler(): Extension {
  return [overviewPlugin, overviewTheme];
}
