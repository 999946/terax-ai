import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet, type ViewUpdate, WidgetType, ViewPlugin } from "@codemirror/view";
import type { GitBlameEntry } from "@/modules/ai/lib/native";

/** Effect payload carrying the per-line blame map for the current file. */
export const setBlameEffect = StateEffect.define<Map<number, GitBlameEntry>>();

const blameField = StateField.define<Map<number, GitBlameEntry>>({
  create: () => new Map(),
  update: (value, tr) => {
    for (const effect of tr.effects) {
      if (effect.is(setBlameEffect)) return effect.value;
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
  const entry = view.state.field(blameField).get(line);
  if (!entry) return Decoration.none;
  const pos = view.state.doc.line(line).to;
  const deco = Decoration.widget({
    widget: new BlameBadgeWidget(entry),
    side: 1,
  });
  return Decoration.set([deco.range(pos)]);
}

const blameBadgePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildBadge(view);
    }
    update(u: ViewUpdate) {
      const blameChanged = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setBlameEffect)),
      );
      if (u.docChanged || u.selectionSet || blameChanged) {
        this.decorations = buildBadge(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

class BlameBadgeWidget extends WidgetType {
  constructor(readonly entry: GitBlameEntry) {
    super();
  }

  eq(other: BlameBadgeWidget): boolean {
    return other.entry === this.entry;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-blame-badge";
    span.textContent = [
      this.entry.shortSha,
      this.entry.author,
      relativeTime(this.entry.timestampSecs),
      this.entry.subject,
    ]
      .filter(Boolean)
      .join(" · ");
    return span;
  }

  ignoreEvent(): boolean {
    return true;
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
    maxWidth: "40ch",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    verticalAlign: "baseline",
    userSelect: "none",
    pointerEvents: "none",
  },
});

/** Wire the blame data field, the badge plugin, and its styling into an editor. */
export function blameBadge(): Extension {
  return [blameField, blameBadgeTheme, blameBadgePlugin];
}
