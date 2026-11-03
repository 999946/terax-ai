/**
 * IDEA-style diff presentation on top of `@codemirror/merge`.
 *
 * IntelliJ paints the whole changed line — background plus a tinted gutter —
 * instead of the engine's thin change bar, labels each block inserted / deleted
 * / modified, colours the changed words inside it, and marks the lines where
 * the other side has rows this one lacks. This module derives all of that from
 * the merge chunks, so the viewer reads like OpenIDEA's (`vcs/cm.ts`) without
 * pulling in its comparison engine.
 */
import { getChunks, mergeViewSiblings, type Chunk } from "@codemirror/merge";
import {
  RangeSet,
  RangeSetBuilder,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
  gutterLineClass,
} from "@codemirror/view";

/** IDEA's change types: both sides have text, only the new side, only the old side. */
export type DiffKind = "modified" | "inserted" | "deleted";

function kindOf(hasA: boolean, hasB: boolean): DiffKind {
  return hasA && hasB ? "modified" : hasA ? "deleted" : "inserted";
}

/** A chunk's type (DiffUtil.getLineDiffType), by the sides that carry lines. */
export function chunkKind(chunk: Chunk): DiffKind {
  return kindOf(chunk.fromA !== chunk.toA, chunk.fromB !== chunk.toB);
}

const KINDS: readonly DiffKind[] = ["modified", "inserted", "deleted"];

function byKind<T>(make: (kind: DiffKind) => T): Record<DiffKind, T> {
  const out = {} as Record<DiffKind, T>;
  for (const kind of KINDS) out[kind] = make(kind);
  return out;
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

/** One line covered by a change on a given pane. */
export type ChangedLine = {
  /** 1-based line number. */
  readonly line: number;
  readonly kind: DiffKind;
  /** The engine compared this chunk's words, so the line takes the lighter
   * "ignored" colour and its inner fragments carry the full one. */
  readonly fine: boolean;
};

/**
 * Lines of `doc` covered by a chunk on `side`. A chunk whose range is empty on
 * this side marks the boundary line, which is how IDEA shows "the other side
 * has lines here".
 */
export function changedLines(
  chunks: readonly Chunk[],
  side: "a" | "b",
  doc: EditorState["doc"],
  /** Whether word comparison is on: only then does a chunk have inner
   * fragments and earn the lighter line colour. */
  words = false,
): ChangedLine[] {
  const out: ChangedLine[] = [];
  for (const chunk of chunks) {
    const from = side === "a" ? chunk.fromA : chunk.fromB;
    const to = side === "a" ? chunk.toA : chunk.toB;
    const kind = chunkKind(chunk);
    const fine = words && chunk.precise;
    if (from === to) {
      out.push({
        line: doc.lineAt(clamp(from, doc.length)).number,
        kind,
        fine,
      });
      continue;
    }
    const first = doc.lineAt(clamp(from, doc.length)).number;
    const last = doc.lineAt(clamp(Math.max(from, to - 1), doc.length)).number;
    for (let line = first; line <= last; line++) out.push({ line, kind, fine });
  }
  return out;
}

/**
 * The side a pane belongs to. Read from the merge facet, not the `cm-merge-*`
 * DOM class: plugins are constructed before the view applies its attributes.
 */
function mergeSide(state: EditorState): "a" | "b" | null {
  return getChunks(state)?.side ?? null;
}

/** How the viewer asks for colours; both policies are off for "Do not highlight". */
export type IdeaDiffStyle = { words: boolean; lines: boolean };

const lineDecorationsByKind = byKind((kind) => ({
  coarse: Decoration.line({ class: `cm-diffLine cm-diffLine-${kind}` }),
  fine: Decoration.line({
    class: `cm-diffLine cm-diffLine-fine cm-diffLine-${kind}`,
  }),
}));

/** Word fragments: the full colour of their own change type. */
const wordDecorationsByKind = byKind((kind) =>
  Decoration.mark({ class: `cm-diffWord cm-diffWord-${kind}` }),
);

/** A word present on the other side only: a thin bar where it would be. */
class EmptyWordMarker extends WidgetType {
  constructor(readonly kind: DiffKind) {
    super();
  }
  eq(other: EmptyWordMarker): boolean {
    return other.kind === this.kind;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = `cm-diffWordEmpty cm-diffWord-${this.kind}`;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

const emptyWordDecorationsByKind = byKind((kind) =>
  Decoration.widget({ widget: new EmptyWordMarker(kind), side: 1 }),
);

class LineClassMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
}

const gutterMarkersByKind = byKind((kind) => ({
  coarse: new LineClassMarker(`cm-diffChangedGutter cm-diffGutter-${kind}`),
  fine: new LineClassMarker(
    `cm-diffChangedGutter cm-diffGutter-${kind} cm-diffGutter-fine`,
  ),
}));

/**
 * Rebuilds `build` when the document, viewport or chunks change — the three
 * inputs every decoration below derives from.
 */
function chunkPlugin(
  build: (view: EditorView, side: "a" | "b") => DecorationSet,
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(readonly view: EditorView) {
        this.decorations = this.build();
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          getChunks(update.startState)?.chunks !==
            getChunks(update.state)?.chunks
        )
          this.decorations = this.build();
      }
      private build(): DecorationSet {
        const side = mergeSide(this.view.state);
        return side ? build(this.view, side) : Decoration.none;
      }
    },
    { decorations: (value) => value.decorations },
  );
}

/** Full-width backgrounds behind every changed line, as IDEA paints them. */
function lineBackgrounds(style: IdeaDiffStyle): Extension {
  if (!style.lines) return [];
  return chunkPlugin((view, side) => {
    const { from: viewportFrom, to: viewportTo } = view.viewport;
    const builder = new RangeSetBuilder<Decoration>();
    const chunks = getChunks(view.state)!.chunks;
    for (const { line, kind, fine } of changedLines(
      chunks,
      side,
      view.state.doc,
      style.words,
    )) {
      const start = view.state.doc.line(line).from;
      if (start > viewportTo) break;
      if (start < viewportFrom) continue;
      builder.add(
        start,
        start,
        fine
          ? lineDecorationsByKind[kind].fine
          : lineDecorationsByKind[kind].coarse,
      );
    }
    return builder.finish();
  });
}

/**
 * IDEA's "Highlight words": the inner fragments of each chunk in the full colour
 * of their own change type, over the lighter line background.
 */
function wordFragments(style: IdeaDiffStyle): Extension {
  if (!style.words) return [];
  return chunkPlugin((view) => {
    const info = getChunks(view.state);
    // The unified viewer's deleted rows are engine widgets, already tinted.
    if (!info || !info.side || !mergeViewSiblings(view)) return Decoration.none;
    const isA = info.side === "a";
    const { from: viewportFrom, to: viewportTo } = view.viewport;
    const builder = new RangeSetBuilder<Decoration>();
    for (const chunk of info.chunks) {
      const base = isA ? chunk.fromA : chunk.fromB;
      if (base > viewportTo) break;
      if ((isA ? chunk.toA : chunk.toB) < viewportFrom) continue;
      for (const change of chunk.changes) {
        const [from, to] = isA
          ? [change.fromA, change.toA]
          : [change.fromB, change.toB];
        const kind = kindOf(
          change.fromA !== change.toA,
          change.fromB !== change.toB,
        );
        if (from < to) {
          builder.add(base + from, base + to, wordDecorationsByKind[kind]);
        } else {
          builder.add(
            base + from,
            base + from,
            emptyWordDecorationsByKind[kind],
          );
        }
      }
    }
    return builder.finish();
  });
}

/**
 * A line where the other side has rows this one lacks — IDEA's "empty side"
 * marker, drawn as a rule above (and below, at the edge of the block) the
 * boundary line.
 */
function gapMarks(): Extension {
  return chunkPlugin((view, side) => {
    // The unified viewer renders the missing rows as its own widgets.
    if (!mergeViewSiblings(view)) return Decoration.none;
    const chunks = getChunks(view.state)?.chunks ?? [];
    const isA = side === "a";
    const { doc } = view.state;
    const { from: viewportFrom, to: viewportTo } = view.viewport;
    const builder = new RangeSetBuilder<Decoration>();
    for (const chunk of chunks) {
      const [from, to] = isA
        ? [chunk.fromA, chunk.toA]
        : [chunk.fromB, chunk.toB];
      if (from !== to) continue;
      if (from > viewportTo) break;
      if (from < viewportFrom) continue;
      const line = doc.lineAt(clamp(from, doc.length));
      const kind = chunkKind(chunk);
      const end = from > doc.length;
      builder.add(
        line.from,
        line.from,
        Decoration.line({
          class: `cm-diffGap cm-diffGap-${kind}${end ? " cm-diffGapEnd" : ""}`,
        }),
      );
    }
    return builder.finish();
  });
}

/**
 * Tinted gutters for changed lines. A state field can read the merge chunks
 * directly, so it recomputes whenever they — or the document — change; a
 * plugin would have to dispatch, and a dispatch from a plugin constructor is
 * dropped.
 */
function changedGutterMarkers(
  state: EditorState,
  words: boolean,
): RangeSet<GutterMarker> {
  const info = getChunks(state);
  if (!info?.side) return RangeSet.empty;
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const { line, kind, fine } of changedLines(
    info.chunks,
    info.side,
    state.doc,
    words,
  )) {
    const start = state.doc.line(line).from;
    builder.add(
      start,
      start,
      fine ? gutterMarkersByKind[kind].fine : gutterMarkersByKind[kind].coarse,
    );
  }
  return builder.finish();
}

const gutterField = (words: boolean) =>
  StateField.define<RangeSet<GutterMarker>>({
    create: (state) => changedGutterMarkers(state, words),
    update(value, tr) {
      if (
        tr.docChanged ||
        getChunks(tr.startState)?.chunks !== getChunks(tr.state)?.chunks
      )
        return changedGutterMarkers(tr.state, words);
      return value;
    },
    provide: (field) => gutterLineClass.from(field),
  });

/**
 * The per-pane extension bundle: line backgrounds, tinted gutters, word
 * fragments and gap markers under the toolbar's highlighting policy.
 */
export function ideaDiffPane(style: IdeaDiffStyle): Extension {
  if (!style.words && !style.lines) return [];
  return [
    EditorView.editorAttributes.of({ class: "cm-diffPane" }),
    lineBackgrounds(style),
    wordFragments(style),
    gapMarks(),
    gutterField(style.words),
  ];
}

/** The index of the change block holding `view`'s cursor, or -1. */
export function currentChunkIndex(view: EditorView): number {
  const info = getChunks(view.state);
  if (!info) return -1;
  const side = info.side ?? "b";
  const head = view.state.selection.main.head;
  const isA = side === "a";
  return info.chunks.findIndex((chunk) => {
    const from = isA ? chunk.fromA : chunk.fromB;
    const to = isA ? chunk.endA : chunk.endB;
    return from <= head && head <= Math.max(from, to);
  });
}
