import { type ChangeSet, type Extension, type Text, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet, type ViewUpdate, WidgetType, ViewPlugin } from "@codemirror/view";
import type { GitBlameEntry } from "@/modules/ai/lib/native";

/** Click context for the blame badge: which repo to open history in, and how to
 * ask for a commit to be focused. `repoRoot: null` means "not a git repo" so no
 * badge is shown. */
export type BlameContext = {
  repoRoot: string | null;
  onClick?: (sha: string) => void;
};

/** Effect payload carrying the per-line blame map for the current file. */
export const setBlameEffect = StateEffect.define<Map<number, GitBlameEntry>>();

/** Effect carrying the blame interaction context (repo + click handler). */
export const setBlameContextEffect = StateEffect.define<BlameContext | null>();

/**
 * Remap every blame entry's line through the edits that just happened. `git
 * blame` reports line numbers of the committed file on disk, so as the doc
 * drifts the keys must follow — otherwise a committed line's badge would point
 * at the wrong line or vanish. Extracted pure for headless unit tests.
 */
export function remapBlameMap(
  value: Map<number, GitBlameEntry>,
  changes: ChangeSet,
  oldDoc: Text,
  newDoc: Text,
): Map<number, GitBlameEntry> {
  if (value.size === 0) return value;
  const next = new Map<number, GitBlameEntry>();
  for (const [line, entry] of value) {
    let from: number | undefined;
    try {
      from = oldDoc.line(line).from;
    } catch {
      continue; // line vanished from the pre-change doc
    }
    const mapped = changes.mapPos(from, 1);
    let newLine: number | undefined;
    try {
      newLine = newDoc.lineAt(mapped).number;
    } catch {
      continue;
    }
    next.set(newLine, entry);
  }
  return next;
}

/**
 * Line-tracking blame map. `git blame` reports line numbers of the committed
 * file on disk, but the editor doc drifts as the user edits. Every entry's key
 * is the *current* doc line of a committed source line; on each document change
 * we remap keys through that transaction's ChangeSet so the badge keeps pointing
 * at the right line (and never drops a committed line just because an edit
 * above it moved everything).
 */
const blameField = StateField.define<Map<number, GitBlameEntry>>({
  create: () => new Map(),
  update: (value, tr) => {
    // A fresh blame map was dispatched for this document (line numbers refer to
    // the doc at dispatch time). Take it as the new base.
    for (const effect of tr.effects) {
      if (effect.is(setBlameEffect)) return effect.value;
    }
    if (!tr.docChanged || value.size === 0) return value;
    return remapBlameMap(value, tr.changes, tr.startState.doc, tr.state.doc);
  },
});

const blameContextField = StateField.define<BlameContext | null>({
  create: () => null,
  update: (value, tr) => {
    for (const effect of tr.effects) {
      if (effect.is(setBlameContextEffect)) return effect.value;
    }
    return value;
  },
});

function activeLine(view: EditorView): number {
  const head = view.state.selection.main.head;
  return view.state.doc.lineAt(head).number;
}

function buildBadge(view: EditorView): DecorationSet {
  const line = activeLine(view);
  if (line <= 0) return Decoration.none;
  const ctx = view.state.field(blameContextField);
  // Not a git repo → show nothing at all.
  if (!ctx?.repoRoot) return Decoration.none;
  const pos = view.state.doc.line(line).to;
  const entry = view.state.field(blameField).get(line);
  // Every committed line has a blame entry; a missing one (e.g. a brand-new
  // line never committed) simply shows nothing — no placeholder.
  if (!entry) return Decoration.none;
  return Decoration.set([
    Decoration.widget({
      widget: new BlameBadgeWidget(entry, ctx),
      side: 1,
    }).range(pos),
  ]);
}

const blameBadgePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildBadge(view);
    }
    update(u: ViewUpdate) {
      const changed = u.transactions.some((tr) =>
        tr.effects.some(
          (e) => e.is(setBlameEffect) || e.is(setBlameContextEffect),
        ),
      );
      if (u.docChanged || u.selectionSet || changed) {
        this.decorations = buildBadge(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

class BlameBadgeWidget extends WidgetType {
  constructor(
    readonly entry: GitBlameEntry,
    readonly ctx: BlameContext,
  ) {
    super();
  }

  eq(other: BlameBadgeWidget): boolean {
    return (
      other.entry === this.entry && other.ctx === this.ctx
    );
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-blame-badge cm-blame-badge--commit";
    span.textContent = [
      this.entry.shortSha,
      this.entry.author,
      relativeTime(this.entry.timestampSecs),
      this.entry.subject,
    ]
      .filter(Boolean)
      .join(" · ");
    span.title = "View commit in history";
    span.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.ctx.onClick && this.entry.sha) this.ctx.onClick(this.entry.sha);
    };
    return span;
  }

  ignoreEvent(): boolean {
    // Let clicks reach the badge; they're handled above and don't move the
    // cursor. Return false so pointer events land on the widget.
    return false;
  }
}

/** Compact relative time ("just now", "5m", "3h", "2d", "6mo"). */
export function relativeTime(secs: number): string {
  if (!secs) return "";
  const diff = Math.max(0, Date.now() / 1000 - secs);
  const minute = 60;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < month) return `${Math.floor(diff / day)}d ago`;
  return `${Math.floor(diff / month)}mo ago`;
}

const blameBadgeTheme = EditorView.theme({
  ".cm-blame-badge": {
    display: "inline-block",
    marginLeft: "0.75em",
    color: "var(--muted-foreground)",
    opacity: "0.6",
    fontSize: "11px",
    fontWeight: 400,
    fontStyle: "italic",
    verticalAlign: "baseline",
    userSelect: "none",
  },
  ".cm-blame-badge--commit": {
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  ".cm-blame-badge--commit:hover": {
    opacity: "1",
    color: "var(--foreground)",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
  },
});

/** Wire the blame data field, the badge plugin, and its styling into an editor. */
export function blameBadge(): Extension {
  return [blameField, blameContextField, blameBadgeTheme, blameBadgePlugin];
}