import {
  Compartment,
  Prec,
  RangeSet,
  StateField,
  type Extension,
  type Text,
} from "@codemirror/state";
import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import type { GitBlameEntry } from "@/modules/ai/lib/native";
import { relativeTime, remapBlameMap, setBlameEffect } from "./blameBadge";

/** Toggleable OpenIDEA-style Git blame annotations in a left gutter. */
export const blameAnnotationsCompartment = new Compartment();

class BlameAnnotationMarker extends GutterMarker {
  constructor(readonly entry?: GitBlameEntry) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof BlameAnnotationMarker &&
      other.entry?.sha === this.entry?.sha &&
      other.entry?.author === this.entry?.author &&
      other.entry?.timestampSecs === this.entry?.timestampSecs
    );
  }
  override toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-blame-annotation";
    if (!this.entry) {
      el.title = "Not committed yet";
      return el;
    }
    el.textContent = `${relativeTime(this.entry.timestampSecs)} ${shortAuthor(this.entry.author)}`;
    el.title = `${this.entry.shortSha}  ${this.entry.author}  ${this.entry.subject}`;
    return el;
  }
}

function shortAuthor(author: string): string {
  const first = author.trim().split(/\s+/)[0] ?? "";
  return first.length > 12 ? `${first.slice(0, 11)}…` : first;
}

export function annotationMarkers(
  entries: Map<number, GitBlameEntry>,
  doc: Text,
): RangeSet<GutterMarker> {
  const result = [] as ReturnType<BlameAnnotationMarker["range"]>[];
  for (let line = 1; line <= doc.lines; line++) {
    result.push(
      new BlameAnnotationMarker(entries.get(line)).range(doc.line(line).from),
    );
  }
  return RangeSet.of(result);
}

type AnnotationState = {
  entries: Map<number, GitBlameEntry>;
  markers: RangeSet<GutterMarker>;
};
const annotationField = StateField.define<AnnotationState>({
  create: () => ({ entries: new Map(), markers: RangeSet.empty }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBlameEffect)) {
        return {
          entries: effect.value,
          markers: annotationMarkers(effect.value, tr.state.doc),
        };
      }
    }
    if (!tr.docChanged) return value;
    // Line-tracking: keep committed entries glued to their source lines as the
    // doc changes (same semantics as the active-line badge). Rebuild markers
    // so an inserted line above "steals" the gutter slot correctly.
    const entries = remapBlameMap(
      value.entries,
      tr.changes,
      tr.startState.doc,
      tr.state.doc,
    );
    return { entries, markers: annotationMarkers(entries, tr.state.doc) };
  },
});

function entryAt(view: EditorView, from: number): GitBlameEntry | undefined {
  const line = view.state.doc.lineAt(from).number;
  return view.state.field(annotationField).entries.get(line);
}

export function blameAnnotationsExtension(
  onClick?: (sha: string) => void,
): Extension {
  return [
    annotationField,
    Prec.high(
      gutter({
        class: "cm-blame-annotations",
        markers: (view) => view.state.field(annotationField).markers,
        domEventHandlers: {
          click(view, block) {
            const entry = entryAt(view, block.from);
            if (entry?.sha && onClick) onClick(entry.sha);
            return true;
          },
        },
      }),
    ),
    EditorView.theme({
      ".cm-blame-annotations": {
        cursor: "pointer",
        borderRight: "1px solid var(--border)",
      },
      ".cm-blame-annotations .cm-gutterElement": {
        minWidth: "14ch",
        padding: "0 8px 0 6px",
        textAlign: "right",
      },
      ".cm-blame-annotation": {
        display: "inline-block",
        whiteSpace: "nowrap",
        fontFamily: "var(--font-ui)",
        fontSize: "11px",
        color: "var(--muted-foreground)",
        opacity: "0.72",
      },
      ".cm-blame-annotations .cm-gutterElement:hover .cm-blame-annotation": {
        color: "var(--foreground)",
        opacity: "1",
      },
    }),
  ];
}
