import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export type BreadcrumbSegment = {
  /** Symbol name (function/class/method/selector/heading…). */
  label: string;
  /** Position of the declaration-name token; click jumps here. */
  from: number;
};

export type BreadcrumbLang = {
  /** Resolved language id; null = no language or oversized file. */
  id: string | null;
};

/** Punctuation / trivia leaf node names — never structural symbols. */
const PUNCT_RE = /[()[\];,{}:=+\-*/<>.?&|!#~%^"'`\\]/;
/** Container / file roots that name no symbol. */
const ROOTISH = new Set([
  "Document",
  "Program",
  "Script",
  "Module",
  "Text",
  "TopLevel",
  "File",
  "Source",
  "Code",
]);
/** Nodes that name a symbol despite opening no brace / multiline scope —
 * headings in Markdown-style documents. A small, deliberate exception: these
 * are the primary navigation units for prose files and carry no body opener. */
const HEADING_RE = /^(ATX|Setext)Heading\d*$/;
/** Name-scan window (chars); only the head of a block is scanned for a name. */
const MAX_SCAN = 80;
/** Body probe window (chars): a block must open a scope within this length. */
const BODY_PROBE = 400;
/** Cap on the ancestor chain, to bound pathological trees. */
const MAX_DEPTH = 32;
/** Delimiters that end a declaration head: the name is the last word before
 * one of these. `function foo(`, `class Box {`, `def speak(self):`. */
const HEAD_DELIM = /[({:]/;
const WORD_RE = /[A-Za-z_$][\w.$-]*/g;

/** Extract a block's name from its head text. Cross-language, no per-language
 * dictionary: the name is the last identifier-word before the first body
 * delimiter (`(`, `{` or `:`), so `function foo(` → `foo`, `class Box {` →
 * `Box`, `def speak(self):` → `speak`. Nodes whose head opens with a delimiter
 * (`{…}` blocks) produce no word and are skipped. Falls back to the first word
 * for delimiter-free languages (Markdown headings, HTML tags, CSS selectors). */
function leadingName(
  node: { from: number; to: number },
  doc: EditorState["doc"],
): { label: string; from: number } | null {
  const cap = Math.min(node.to, node.from + MAX_SCAN);
  if (cap <= node.from + 1) return null;
  const text = doc.sliceString(node.from, cap);

  // Name = last word before the first body delimiter.
  const dm = HEAD_DELIM.exec(text);
  const head = dm ? text.slice(0, dm.index) : text;
  const words = [...head.matchAll(WORD_RE)];
  if (words.length) {
    const last = words[words.length - 1];
    return { label: last[0], from: node.from + last.index };
  }

  // No delimiter and no leading word (e.g. an opener-only node) → not a symbol.
  return null;
}

/** Is this node a structural block? A generic "opens a scope" test that covers
 * all lezer languages without a per-language node-name table: it must render
 * braces `{…}` or span multiple lines (a `def:`/`class:`/tag block), while
 * single-line expressions (`foo();`, `return x`) and trivia are filtered out. */
function isStructural(
  node: { type: { isError: boolean }; name: string; from: number; to: number },
  doc: EditorState["doc"],
): boolean {
  if (node.type.isError) return false;
  const name = node.name;
  if (!name) return false;
  if (PUNCT_RE.test(name)) return false; // punctuation / token leaf
  if (ROOTISH.has(name)) return false; // container root
  const probe = doc.sliceString(
    node.from,
    Math.min(node.to, node.from + BODY_PROBE),
  );
  if (!probe.includes("{") && !probe.includes("\n")) {
    // No brace / multiline scope — only headings name a symbol here.
    return HEADING_RE.test(name);
  }
  return probe.trim().length > 0;
}

/** Pure: compute the cursor's symbol breadcrumb from a state. Returns null for
 * empty docs, non-lezer languages, and oversized files (caller passes
 * `lang.id = null` when the language compartment was cleared). */
export function computeSymbolBreadcrumb(
  state: EditorState,
  lang: BreadcrumbLang,
): BreadcrumbSegment[] | null {
  if (state.doc.length === 0) return null;
  if (!lang?.id) return null;

  const tree = syntaxTree(state);
  if (!tree.topNode || tree.length === 0) return null;

  const head = state.selection.main.head;
  const node = tree.resolveInner(head, -1);
  if (!node) return null;

  const out: BreadcrumbSegment[] = [];
  let n: ReturnType<typeof tree.resolveInner> | null = node;
  let guard = 0;
  while (n && guard++ < MAX_DEPTH) {
    if (isStructural(n, state.doc)) {
      const nm = leadingName(n, state.doc);
      if (nm && nm.label && nm.label.trim().length > 0) {
        const last = out[out.length - 1];
        if (!last || last.from !== nm.from) out.push(nm);
      }
    }
    n = n.parent;
  }
  out.reverse(); // outermost → innermost
  return out.length ? out : null;
}

/** Extension: recomputes the breadcrumb on doc/selection changes (batched via
 * requestAnimationFrame, deduped by a serialized identity) and pushes into
 * `onChange`. `refresh()` forces a re-emit so the component can surface this
 * out-of-band when the resolved language changes. */
export function symbolBreadcrumb(
  getLanguage: () => BreadcrumbLang,
  onChange: (segments: BreadcrumbSegment[] | null) => void,
): { extension: Extension; refresh: () => void } {
  let view: EditorView | null = null;
  let raf = 0;
  let last = "";

  const emit = () => {
    if (!view) return;
    const segs = computeSymbolBreadcrumb(view.state, getLanguage());
    const key = segs ? JSON.stringify(segs) : "null";
    if (key === last) return;
    last = key;
    onChange(segs);
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
      // update will emit the first breadcrumb.
      if (view) {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(emit);
      }
    },
  };
}
