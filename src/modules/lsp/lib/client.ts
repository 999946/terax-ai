import {
  highlightingFor,
  indentUnit,
  language,
  syntaxTree,
} from "@codemirror/language";
import {
  type Extension,
  StateEffect,
  StateField,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  type Panel,
  hoverTooltip,
  showPanel,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { highlightCode } from "@lezer/highlight";
import {
  LanguageServerClient,
  languageServerPlugin,
  renameSymbol,
} from "codemirror-languageserver";
import {
  type LocationItem,
  locationsPanel,
  openLocationsPanel,
} from "./locationsPanel";
import { fileUriToPath } from "./uri";

export {
  languageServerWithTransport,
  SynchronizationMethod,
} from "codemirror-languageserver";

type LspPos = { line: number; character: number };
type LspRange = { start: LspPos };

type LspLocation = { uri: string; range: LspRange };
type LspLocationLink = {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange?: LspRange;
};
type DefinitionResult =
  | LspLocation
  | LspLocation[]
  | LspLocationLink[]
  | null
  | undefined;

/** LSP DocumentHighlight kinds: 1 = text, 2 = read, 3 = write. */
export type DocumentHighlight = {
  range: { start: LspPos; end: LspPos };
  kind?: 1 | 2 | 3;
};

export type Hover = {
  contents:
    | string
    | { kind: "plaintext" | "markdown"; value: string }
    | Array<string | { kind: "plaintext" | "markdown"; value: string }>;
};

/** Flatten LSP hover contents into plain text. */
export function hoverText(hover: Hover | null): string | null {
  if (!hover) return null;
  const parts = Array.isArray(hover.contents)
    ? hover.contents
    : [hover.contents];
  const text = parts
    .map((part) => (typeof part === "string" ? part : (part?.value ?? "")))
    .join("\n\n")
    .trim();
  return text === "" ? null : text;
}

function normalizeLocations(result: DefinitionResult): LspLocation[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  const out: LspLocation[] = [];
  for (const loc of list) {
    if ("uri" in loc) {
      out.push(loc);
    } else if (loc.targetUri) {
      out.push({
        uri: loc.targetUri,
        range: loc.targetSelectionRange ?? loc.targetRange,
      });
    }
  }
  return out;
}

function offsetOf(doc: Text, pos: LspPos): number {
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(pos.line + 1);
  return Math.min(line.from + pos.character, line.to);
}

export type LspFormatResult = "done" | "unsupported";

// The lib's formatDocument command fires and forgets; save needs to await
// the edits before writing to disk. "unsupported" surfaces servers that
// simply have no formatter (pyright) so the UI can say so instead of
// silently doing nothing.
export async function formatDocumentAndWait(
  view: EditorView,
): Promise<LspFormatResult> {
  const plugin = view.plugin(languageServerPlugin);
  if (!plugin) return "unsupported";
  const { client } = plugin;
  if (!client.ready || !client.capabilities?.documentFormattingProvider) {
    return "unsupported";
  }
  const doc = view.state.doc;
  const edits = await client.textDocumentFormatting({
    textDocument: { uri: plugin.documentUri },
    options: {
      tabSize: view.state.tabSize,
      insertSpaces: view.state.facet(indentUnit) !== "\t",
    },
  });
  if (!edits || edits.length === 0) return "done";
  // Edits are offsets into the requested snapshot; typing during the
  // round-trip would corrupt the document.
  if (view.state.doc !== doc) return "done";
  view.dispatch({
    changes: edits.map((e) => ({
      from: offsetOf(doc, e.range.start),
      to: offsetOf(doc, e.range.end),
      insert: e.newText,
    })),
  });
  return "done";
}

function highlightBlock(el: HTMLElement, view: EditorView): void {
  const lang = view.state.facet(language);
  const code = el.textContent;
  if (!lang || !code) return;
  const frag = document.createDocumentFragment();
  highlightCode(
    code,
    lang.parser.parse(code),
    { style: (tags) => highlightingFor(view.state, tags) },
    (text, classes) => {
      if (!classes) {
        frag.appendChild(document.createTextNode(text));
        return;
      }
      const span = document.createElement("span");
      span.className = classes;
      span.textContent = text;
      frag.appendChild(span);
    },
    () => frag.appendChild(document.createTextNode("\n")),
  );
  el.replaceChildren(frag);
}

// Tooltip docs arrive as plain markdown-rendered code; tokenize them with
// the file's own parser so signatures match the editor theme. Tooltips are
// direct children of the editor DOM, so the outer observer never fires on
// typing; the subtree observer lives only while a tooltip is mounted.
const hoverCodeHighlight = ViewPlugin.define((view) => {
  const seen = new WeakSet<HTMLElement>();
  const inner = new Map<Element, MutationObserver>();

  const scan = (root: Element) => {
    const blocks = root.querySelectorAll<HTMLElement>(
      ".documentation pre code",
    );
    for (const el of blocks) {
      if (seen.has(el)) continue;
      seen.add(el);
      highlightBlock(el, view);
    }
  };

  const outer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (
          !(node instanceof Element) ||
          !node.classList.contains("cm-tooltip")
        ) {
          continue;
        }
        scan(node);
        const ob = new MutationObserver(() => scan(node));
        ob.observe(node, { childList: true, subtree: true });
        inner.set(node, ob);
      }
      for (const node of m.removedNodes) {
        if (!(node instanceof Element)) continue;
        inner.get(node)?.disconnect();
        inner.delete(node);
      }
    }
  });
  outer.observe(view.dom, { childList: true });

  return {
    destroy: () => {
      outer.disconnect();
      for (const ob of inner.values()) ob.disconnect();
      inner.clear();
    },
  };
});

const setLinkRange = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: "cm-lsp-link" });

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setLinkRange)) {
        return e.value
          ? Decoration.set([linkMark.range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function currentLink(view: EditorView): { from: number; to: number } | null {
  const iter = view.state.field(linkField).iter();
  return iter.value ? { from: iter.from, to: iter.to } : null;
}

function updateLink(view: EditorView, event: MouseEvent | null): void {
  const prev = currentLink(view);
  let next: { from: number; to: number } | null = null;
  if (event && (event.metaKey || event.ctrlKey)) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos != null) next = view.state.wordAt(pos);
  }
  if (prev?.from === next?.from && prev?.to === next?.to) return;
  view.dispatch({ effects: setLinkRange.of(next) });
}

// Cmd/Ctrl-hover underlines the symbol under the pointer, matching the
// mod-click go-to-definition affordance.
const linkHover: Extension = [
  linkField,
  EditorView.domEventHandlers({
    mousemove: (event, view) => updateLink(view, event),
    keyup: (event, view) => {
      if (event.key === "Meta" || event.key === "Control") {
        updateLink(view, null);
      }
    },
    mouseleave: (_e, view) => updateLink(view, null),
  }),
  EditorView.theme({
    ".cm-lsp-link": {
      textDecoration: "underline",
      textUnderlineOffset: "2.5px",
      color: "var(--primary)",
      cursor: "pointer",
    },
  }),
];

// ---------------------------------------------------------------------------
// Syntax fallback (OpenIDEA's "dumb mode")

export const SYNTAX_NOTE = "Based on syntax (language server not ready)";

/**
 * Declaration targets the syntax tree is *certain* about, used only when the
 * language server is unavailable. Deliberately conservative: a local
 * declaration inside the enclosing scopes wins; anything wider is not guessed.
 */
export type FallbackTarget = { from: number; to: number };

/** Name of the identifier at `pos`, or null when there is no word there. */
export function identifierAt(
  view: EditorView,
  pos: number,
): { name: string; from: number; to: number } | null {
  const word = view.state.wordAt(pos);
  if (!word) return null;
  const name = view.state.sliceDoc(word.from, word.to);
  return name === "" ? null : { name, from: word.from, to: word.to };
}

/**
 * Node names that lezer grammars use for a declaration's own name (as opposed
 * to a reference). Verified per language: JavaScript/TypeScript uses
 * `VariableDefinition`, Python `VariableName` under a `FunctionDefinition` /
 * `ClassDefinition`, Rust `BoundIdentifier`. Lezer tags declarations with a
 * *distinct* node name in these grammars, so matching the name is exact and
 * never confuses `greet()` with `function greet`.
 */
const DECLARATION_NAME_NODES = new Set([
  "VariableDefinition",
  "BoundIdentifier",
  "FunctionName",
  "ClassName",
  "TypeName",
  "MethodName",
  "PropertyName",
  "DefName",
]);

/** Parents that make a plain identifier node a declaration name. */
const DECLARATION_PARENTS =
  /^(FunctionDefinition|ClassDefinition|MethodDefinition|FunctionDeclaration|ClassDeclaration|InterfaceDeclaration|StructItem|EnumItem|TraitItem|TypeAlias|ConstItem|StaticItem|ModuleDeclaration|NamespaceDeclaration)$/;

/** Whether the syntax-tree node at `name`/`parent` is a declaration's own name. */
export function isDeclarationName(name: string, parentName: string): boolean {
  if (DECLARATION_NAME_NODES.has(name)) return true;
  if (name !== "VariableName" && name !== "Identifier") return false;
  return DECLARATION_PARENTS.test(parentName);
}

export function syntaxDeclarations(
  view: EditorView,
  name: string,
): FallbackTarget[] {
  const found: FallbackTarget[] = [];
  const { doc } = view.state;
  const cursor = syntaxTree(view.state).cursor();
  do {
    if (!isDeclarationName(cursor.name, cursor.node.parent?.name ?? ""))
      continue;
    const { from, to } = cursor;
    if (doc.sliceString(from, to) !== name) continue;
    found.push({ from, to });
  } while (cursor.next());
  return found.sort((a, b) => a.from - b.from);
}

/** Whether the point at `pos` is already inside one of `targets`. */
export function isSelfTarget(
  pos: number,
  targets: readonly FallbackTarget[],
): boolean {
  return targets.some((t) => t.from <= pos && pos <= t.to);
}

/** A one-line declaration summary for the ⌘-hover tooltip. */
export function declarationSummary(text: string): string {
  const first = text.split("\n").find((line) => line.trim() !== "");
  return (first ?? "").trim().slice(0, 300);
}

/** Navigation kinds, mirroring OpenIDEA's GotoKind. */
export type GotoKind = "definition" | "implementation" | "typeDefinition";

const GOTO_TITLES: Record<GotoKind, string> = {
  definition: "Choose Declaration",
  implementation: "Choose Implementation",
  typeDefinition: "Choose Type Declaration",
};

const GOTO_NOT_FOUND: Record<GotoKind, string> = {
  definition: "Cannot find declaration to go to",
  implementation: "No implementations found",
  typeDefinition: "Cannot find type declaration",
};

/** An inline hint line above the editor, replacing silent failures. */
const hintField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setHint)) return e.value;
    }
    return tr.docChanged ? null : value;
  },
  provide: (f) =>
    showPanel.from(f, (text) => (text ? () => createHintPanel(text) : null)),
});

const setHint = StateEffect.define<string | null>();

function createHintPanel(text: string): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hint";
  dom.textContent = text;
  return { dom };
}

function showHint(view: EditorView, text: string, ms = 2000): void {
  view.dispatch({ effects: setHint.of(text) });
  setTimeout(() => {
    if (view.state.field(hintField, false) === text) {
      view.dispatch({ effects: setHint.of(null) });
    }
  }, ms);
}

// ---------------------------------------------------------------------------
// Usages of the element at caret (⌘⇧F7)

type UsageHighlight = {
  deco: DecorationSet;
  sticky: boolean;
};

export const usageHighlightField = StateField.define<UsageHighlight>({
  create: () => ({ deco: Decoration.none, sticky: false }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setUsageHighlights)) {
        return {
          deco: Decoration.set(
            e.value.items
              .filter((item) => item.from < item.to)
              .map((item) =>
                (item.kind === 2
                  ? occurrenceRead
                  : item.kind === 3
                    ? occurrenceWrite
                    : occurrenceText
                ).range(item.from, item.to),
              ),
            true,
          ),
          sticky: e.value.sticky,
        };
      }
    }
    // Mapped (not dropped) across edits while sticky, like IDEA's daemon marks.
    if (tr.docChanged)
      return { deco: value.deco.map(tr.changes), sticky: value.sticky };
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const setUsageHighlights = StateEffect.define<{
  items: UsageItem[];
  sticky: boolean;
}>();

const occurrenceText = Decoration.mark({ class: "cm-lsp-occurrence" });
const occurrenceRead = Decoration.mark({
  class: "cm-lsp-occurrence cm-lsp-occurrence-read",
});
const occurrenceWrite = Decoration.mark({
  class: "cm-lsp-occurrence cm-lsp-occurrence-write",
});

type UsageItem = { from: number; to: number; kind: 1 | 2 | 3 };

function clearUsageHighlights(view: EditorView): void {
  view.dispatch({
    effects: setUsageHighlights.of({ items: [], sticky: false }),
  });
}

type UsageRequester = (view: EditorView, pos: number) => Promise<UsageItem[]>;

/** ⌘⇧F7: highlight usages until Escape; on a highlighted usage it removes them. */
function toggleUsageHighlights(
  view: EditorView,
  request: UsageRequester,
): void {
  const state = view.state.field(usageHighlightField, false);
  const head = view.state.selection.main.head;
  let onUsage = false;
  state?.deco.between(head, head, (from, to) => {
    if (from <= head && head <= to) onUsage = true;
  });
  if (state?.sticky && onUsage) {
    clearUsageHighlights(view);
    return;
  }
  void fetchUsageHighlights(view, true, request);
}

/** ⌃⌥↓ / ⌃⌥↑: next (previous) highlighted usage, wrapping. */
function gotoHighlightedUsage(view: EditorView, dir: 1 | -1): boolean {
  const state = view.state.field(usageHighlightField, false);
  const ranges: Array<{ from: number; to: number }> = [];
  state?.deco.between(
    0,
    view.state.doc.length,
    (from, to) => void ranges.push({ from, to }),
  );
  const head = view.state.selection.main.head;
  const current = ranges.findIndex((r) => r.from <= head && head <= r.to);
  if (ranges.length < 2 || current < 0) return false;
  const target = ranges[(current + dir + ranges.length) % ranges.length];
  const pos = Math.min(target.from + (head - ranges[current].from), target.to);
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  return true;
}

async function fetchUsageHighlights(
  view: EditorView,
  sticky: boolean,
  request: UsageRequester,
): Promise<void> {
  const head = view.state.selection.main.head;
  const doc = view.state.doc;
  const ident = identifierAt(view, head);
  if (!ident) return;
  const stale = () =>
    view.state.doc !== doc || view.state.selection.main.head !== head;
  const apply = (items: UsageItem[]) => {
    view.dispatch({
      effects: setUsageHighlights.of({
        items,
        sticky: sticky && items.length > 0,
      }),
    });
  };
  try {
    const result = await request(view, head);
    if (stale()) return;
    apply(result);
  } catch {
    if (stale()) return;
    // No server: only same-file declarations the syntax tree is sure about.
    const local = syntaxDeclarations(view, ident.name).map((t) => ({
      from: t.from,
      to: t.to,
      kind: 1 as const,
    }));
    apply(local);
    if (sticky && local.length > 0) showHint(view, SYNTAX_NOTE, 2500);
  }
}

/** Caret-driven, debounced recompute (IDEA's "usages of element at caret"). */
const usageHighlightPlugin = (request: UsageRequester) =>
  ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | undefined;
      constructor(readonly view: EditorView) {}
      update(update: ViewUpdate): void {
        if (!update.selectionSet && !update.docChanged) return;
        const state = update.state.field(usageHighlightField);
        if (state.sticky) {
          clearTimeout(this.timer);
          return;
        }
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          if (this.view.state.selection.main.empty) {
            void fetchUsageHighlights(this.view, false, request);
          } else if (this.view.state.field(usageHighlightField).deco.size) {
            clearUsageHighlights(this.view);
          }
        }, 300);
      }
      destroy(): void {
        clearTimeout(this.timer);
      }
    },
  );

function usageRequester(opts: {
  client: TeraxLspClient;
  documentUri: string;
}): UsageRequester {
  return async (view, pos) => {
    const line = view.state.doc.lineAt(pos);
    const pos0 = { line: line.number - 1, character: pos - line.from };
    const result = await opts.client.textDocumentDocumentHighlightAt({
      textDocument: { uri: opts.documentUri },
      position: pos0,
    });
    const out: UsageItem[] = [];
    for (const highlight of result ?? []) {
      const from = offsetOf(view.state.doc, highlight.range.start);
      const to = offsetOf(view.state.doc, highlight.range.end);
      out.push({ from, to, kind: highlight.kind ?? 1 });
    }
    return out;
  };
}

function usageHighlights(request: UsageRequester): Extension {
  return [usageHighlightField, usageHighlightPlugin(request)];
}

/** ⌘-hover tooltip: the declaration signature of the underlined symbol. */
function navigationTooltip(opts: {
  client: TeraxLspClient;
  documentUri: string;
}): Extension {
  return hoverTooltip(async (view, pos) => {
    if (!view.state.field(linkField, false)?.size) return null;
    const line = view.state.doc.lineAt(pos);
    let hover: Hover | null;
    try {
      hover = await opts.client.textDocumentHoverAt({
        textDocument: { uri: opts.documentUri },
        position: { line: line.number - 1, character: pos - line.from },
      });
    } catch {
      return null;
    }
    const text = hoverText(hover);
    if (!text) return null;
    const summary = declarationSummary(text);
    return {
      pos,
      above: true,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-lsp-hover cm-lsp-nav-info";
        dom.textContent = summary;
        return { dom };
      },
    };
  });
}

export function lspInteractions(opts: {
  client: TeraxLspClient;
  documentUri: string;
  rootPath: string;
  onExternal: (uri: string, line: number, character?: number) => void;
}): Extension {
  const navigate = (view: EditorView, loc: LspLocation): void => {
    if (loc.uri === opts.documentUri) {
      const targetLine = Math.min(
        loc.range.start.line + 1,
        view.state.doc.lines,
      );
      const lineObj = view.state.doc.line(targetLine);
      const target = Math.min(
        lineObj.from + loc.range.start.character,
        lineObj.to,
      );
      view.dispatch({
        selection: { anchor: target },
        effects: EditorView.scrollIntoView(target, { y: "center" }),
      });
      view.focus();
    } else {
      opts.onExternal(
        loc.uri,
        loc.range.start.line + 1,
        loc.range.start.character,
      );
    }
  };

  const label = (loc: LspLocation): string => {
    const path = fileUriToPath(loc.uri) ?? loc.uri;
    const rel = path.startsWith(`${opts.rootPath}/`)
      ? path.slice(opts.rootPath.length + 1)
      : path;
    return `${rel}:${loc.range.start.line + 1}`;
  };

  const dedupe = (locs: LspLocation[]): LspLocation[] => {
    const seen = new Set<string>();
    return locs.filter((loc) => {
      const key = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  /** Multiple targets: the chooser list, titled like IDEA ("of foo (3 found)"). */
  const showChooser = (
    view: EditorView,
    title: string,
    locs: LspLocation[],
  ): void => {
    if (locs.length === 0) return;
    if (locs.length === 1) {
      navigate(view, locs[0]);
      return;
    }
    const byLoc = new Map<string, LspLocation>();
    for (const loc of dedupe(locs)) byLoc.set(label(loc), loc);
    const items: LocationItem[] = [...byLoc.entries()]
      .map(([text, loc]) => ({
        uri: loc.uri,
        line: loc.range.start.line,
        character: loc.range.start.character,
        label: text,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
    openLocationsPanel(view, {
      title,
      items,
      onPick: (item) =>
        navigate(view, {
          uri: item.uri,
          range: { start: { line: item.line, character: item.character } },
        }),
    });
  };

  const positionAt = (view: EditorView, pos: number) => {
    const line = view.state.doc.lineAt(pos);
    return { line: line.number - 1, character: pos - line.from };
  };

  const requestTargets = async (
    view: EditorView,
    kind: GotoKind,
    pos: number,
  ): Promise<DefinitionResult> => {
    const params = {
      textDocument: { uri: opts.documentUri },
      position: positionAt(view, pos),
    };
    if (kind === "implementation")
      return opts.client.textDocumentImplementationAt(params);
    if (kind === "typeDefinition")
      return opts.client.textDocumentTypeDefinitionAt(params);
    return opts.client.textDocumentDefinition(params);
  };

  /**
   * Some servers analyse an edit asynchronously and answer from the previous
   * version meanwhile, so an empty answer right after typing is retried a few
   * times before it is believed. (OpenIDEA's gotoAfterEdits.)
   */
  const targetAfterEdits = async (
    view: EditorView,
    kind: GotoKind,
    pos: number,
  ): Promise<{ locs: LspLocation[]; failed: boolean }> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const locs = normalizeLocations(await requestTargets(view, kind, pos));
        if (locs.length || attempt >= 2) return { locs, failed: false };
      } catch {
        if (attempt >= 2) return { locs: [], failed: true };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  /** Syntax-tree answer: declarations of the identifier in this file. */
  const fallbackTargets = (view: EditorView, pos: number): FallbackTarget[] => {
    const ident = identifierAt(view, pos);
    if (!ident) return [];
    return syntaxDeclarations(view, ident.name);
  };

  const gotoTargets = async (
    view: EditorView,
    kind: GotoKind,
    pos: number,
  ): Promise<void> => {
    const ident = identifierAt(view, pos);
    const { locs, failed } = await targetAfterEdits(view, kind, pos);

    if (locs.length > 0) {
      // ⌘B on a declaration itself shows its usages, like IDEA.
      if (
        kind === "definition" &&
        ident &&
        locs.length === 1 &&
        locs[0].uri === opts.documentUri &&
        locs[0].range.start.line === positionAt(view, pos).line
      ) {
        void findReferences(view, pos);
        return;
      }
      showChooser(
        view,
        `${GOTO_TITLES[kind]}${ident ? ` of ${ident.name}` : ""} (${locs.length} found)`,
        locs,
      );
      return;
    }

    // No server answer. Only the definition kind falls back, and only to a
    // declaration the syntax tree is certain about.
    if (kind === "definition" && ident) {
      const local = fallbackTargets(view, pos);
      if (local.length > 0 && !isSelfTarget(pos, local)) {
        const target = local[0];
        view.dispatch({
          selection: { anchor: target.from },
          effects: EditorView.scrollIntoView(target.from, { y: "center" }),
        });
        view.focus();
        showHint(view, SYNTAX_NOTE, 2500);
        return;
      }
    }

    showHint(
      view,
      failed
        ? `${GOTO_NOT_FOUND[kind]}: no language server is running for this file`
        : GOTO_NOT_FOUND[kind],
    );
  };

  const findReferences = async (
    view: EditorView,
    pos: number,
  ): Promise<void> => {
    let result: LspLocation[] | null;
    try {
      result = await opts.client.textDocumentReferences({
        textDocument: { uri: opts.documentUri },
        position: positionAt(view, pos),
        context: { includeDeclaration: true },
      });
    } catch {
      showHint(view, "References need a running language server");
      return;
    }
    if (!result || result.length === 0) {
      showHint(view, "No usages found");
      return;
    }
    showChooser(view, `Usages (${result.length} found)`, result);
  };

  const request = usageRequester(opts);
  const usage = usageHighlights(request);

  return [
    locationsPanel,
    hoverCodeHighlight,
    linkHover,
    navigationTooltip(opts),
    hintField,
    usage,
    EditorView.baseTheme({
      ".cm-lsp-hint": {
        padding: "4px 8px",
        fontSize: "12px",
        color: "var(--muted-foreground)",
        borderBottom: "1px solid var(--border)",
      },
      ".cm-lsp-occurrence": { backgroundColor: "var(--lsp-occurrence)" },
      ".cm-lsp-occurrence-read": {
        backgroundColor: "transparent",
        outline: "1px solid var(--lsp-occurrence)",
        outlineOffset: "-1px",
      },
      ".cm-lsp-occurrence-write": {
        backgroundColor: "transparent",
        outline: "1px solid var(--lsp-occurrence-write)",
        outlineOffset: "-1px",
      },
    }),
    keymap.of([
      {
        key: "F12",
        preventDefault: true,
        run: (view) => {
          void gotoTargets(view, "definition", view.state.selection.main.head);
          return true;
        },
      },
      {
        key: "Mod-b",
        preventDefault: true,
        run: (view) => {
          void gotoTargets(view, "definition", view.state.selection.main.head);
          return true;
        },
      },
      {
        key: "Alt-Mod-b",
        preventDefault: true,
        run: (view) => {
          void gotoTargets(
            view,
            "implementation",
            view.state.selection.main.head,
          );
          return true;
        },
      },
      {
        key: "Shift-Mod-b",
        preventDefault: true,
        run: (view) => {
          void gotoTargets(
            view,
            "typeDefinition",
            view.state.selection.main.head,
          );
          return true;
        },
      },
      {
        key: "Shift-F12",
        preventDefault: true,
        run: (view) => {
          void findReferences(view, view.state.selection.main.head);
          return true;
        },
      },
      {
        key: "Mod-Shift-F7",
        preventDefault: true,
        run: (view) => {
          toggleUsageHighlights(view, request);
          return true;
        },
      },
      {
        key: "Ctrl-Alt-ArrowDown",
        preventDefault: true,
        run: (view) => gotoHighlightedUsage(view, 1),
      },
      {
        key: "Ctrl-Alt-ArrowUp",
        preventDefault: true,
        run: (view) => gotoHighlightedUsage(view, -1),
      },
      {
        key: "Escape",
        run: (view) => {
          if (!view.state.field(usageHighlightField, false)?.sticky)
            return false;
          clearUsageHighlights(view);
          return true;
        },
      },
      {
        key: "F2",
        preventDefault: true,
        run: renameSymbol,
      },
      {
        key: "Shift-Alt-f",
        preventDefault: true,
        run: (view) => {
          void formatDocumentAndWait(view);
          return true;
        },
      },
    ]),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        // IDEA parity: a plain middle click navigates without any modifier.
        const middle = event.button === 1;
        const mod = event.metaKey || event.ctrlKey;
        if (!middle && !mod) return false;
        if (
          middle &&
          (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        )
          return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos == null) return false;
        event.preventDefault();
        view.dispatch({ selection: { anchor: pos } });
        view.focus();
        void gotoTargets(view, "definition", pos);
        return true;
      },
    }),
  ];
}

type RawRpc = {
  notify(method: string, params: unknown): Promise<void>;
  request(method: string, params: unknown, timeout: number): Promise<unknown>;
};

// The lib's notify/request maps omit didClose, didSave and the
// shutdown/exit handshake; servers need all three for correct lifecycle.
export class TeraxLspClient extends LanguageServerClient {
  static hostPid: number | null = null;

  // The lib omits the publishDiagnostics capability and servers like
  // typescript-language-server push no diagnostics without it. processId
  // enables the server-side parent watchdog.
  protected override getInitializeParams() {
    const params = super.getInitializeParams();
    params.processId = TeraxLspClient.hostPid;
    params.capabilities.textDocument = {
      ...params.capabilities.textDocument,
      publishDiagnostics: { relatedInformation: true },
      references: { dynamicRegistration: false },
    };
    return params;
  }

  textDocumentReferences(params: {
    textDocument: { uri: string };
    position: LspPos;
    context: { includeDeclaration: boolean };
  }): Promise<LspLocation[] | null> {
    return this.raw.request(
      "textDocument/references",
      params,
      10_000,
    ) as Promise<LspLocation[] | null>;
  }

  // implementation / typeDefinition are not in the lib's typed surface even
  // though every mainstream server supports them; go through the raw channel.
  textDocumentImplementationAt(params: {
    textDocument: { uri: string };
    position: LspPos;
  }): Promise<DefinitionResult> {
    return this.raw.request(
      "textDocument/implementation",
      params,
      10_000,
    ) as Promise<DefinitionResult>;
  }

  textDocumentTypeDefinitionAt(params: {
    textDocument: { uri: string };
    position: LspPos;
  }): Promise<DefinitionResult> {
    return this.raw.request(
      "textDocument/typeDefinition",
      params,
      10_000,
    ) as Promise<DefinitionResult>;
  }

  textDocumentDocumentHighlightAt(params: {
    textDocument: { uri: string };
    position: LspPos;
  }): Promise<DocumentHighlight[] | null> {
    return this.raw.request(
      "textDocument/documentHighlight",
      params,
      5_000,
    ) as Promise<DocumentHighlight[] | null>;
  }

  textDocumentHoverAt(params: {
    textDocument: { uri: string };
    position: LspPos;
  }): Promise<Hover | null> {
    return this.raw.request(
      "textDocument/hover",
      params,
      5_000,
    ) as Promise<Hover | null>;
  }

  textDocumentDidClose(uri: string): void {
    void this.raw.notify("textDocument/didClose", { textDocument: { uri } });
  }

  textDocumentDidSave(uri: string): void {
    void this.raw.notify("textDocument/didSave", { textDocument: { uri } });
  }

  async shutdownGracefully(timeoutMs = 2000): Promise<void> {
    try {
      await this.raw.request("shutdown", null, timeoutMs);
      await this.raw.notify("exit", null);
    } catch {
      // Server already dead or unresponsive; the transport kill follows.
    }
  }

  private get raw(): RawRpc {
    return this as unknown as RawRpc;
  }
}
