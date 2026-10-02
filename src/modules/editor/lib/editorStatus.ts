import { indentUnit } from "@codemirror/language";
import { type EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export type Eol = "\n" | "\r\n";

export type EditorStatusInfo = {
  /** 1-based line of the main cursor. */
  line: number;
  /** 1-based column of the main cursor. */
  col: number;
  eol: Eol;
  /** The indent unit (spaces or tab) applied to this document. */
  indentUnit: string;
  language: string | null;
  readonly: boolean;
  dirty: boolean;
};

/** Values that change outside of CM updates (dirty, language, EOL). */
export type EditorStatusExtra = {
  eol: Eol;
  language: string | null;
  readonly: boolean;
  dirty: boolean;
};

/**
 * Pure status computation from a CodeMirror state — unit-testable without a view.
 */
export function computeEditorStatus(
  state: EditorState,
  extra: EditorStatusExtra,
): EditorStatusInfo {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return {
    line: line.number,
    col: head - line.from + 1,
    eol: extra.eol,
    indentUnit: state.facet(indentUnit),
    language: extra.language,
    readonly: extra.readonly,
    dirty: extra.dirty,
  };
}

/**
 * Editor status bar extension. Recomputes the status on doc/selection changes
 * (batched through requestAnimationFrame, deduped by an identity string) and
 * pushes into `onChange`. `refresh()` forces a re-emit so the component can
 * surface out-of-band changes like dirty state or a resolved language.
 */
export function editorStatus(
  getExtra: () => EditorStatusExtra,
  onChange: (info: EditorStatusInfo) => void,
): { extension: Extension; refresh: () => void } {
  let view: EditorView | null = null;
  let raf = 0;
  let last = "";

  const emit = () => {
    if (!view) return;
    const info = computeEditorStatus(view.state, getExtra());
    const key = JSON.stringify(info);
    if (key === last) return;
    last = key;
    onChange(info);
  };

  const schedule = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(emit);
  };

  const extension = EditorView.updateListener.of((u) => {
    view = u.view;
    if (u.docChanged || u.selectionSet) schedule();
  });

  return {
    extension,
    refresh: () => {
      // A null view (not yet mounted) can be ignored — the initial mount's
      // update will emit the first status.
      if (view) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(emit);
      }
    },
  };
}
