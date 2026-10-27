/**
 * Three-pane merge conflict editor: Yours | Result | Theirs.
 *
 * Adapted from OpenIDEA (Apache-2.0, `l0ng-ai/openidea`,
 * `src/features/vcs/MergeEditor.tsx`): the user's side and the incoming side
 * are shown read-only against the common base, the middle Result pane starts
 * from the three-way auto-merge with every conflict block replaced by its base
 * section (no markers), and each unresolved conflict gets inline Accept
 * buttons. Applying writes the result to disk, stages it, and the caller
 * refreshes.
 */
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { history, historyKeymap } from "@codemirror/commands";
import { unifiedMergeView } from "@codemirror/merge";
import {
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { GitMergeSides, GitMergeVersions } from "@/modules/ai/lib/native";
import { native } from "@/modules/ai/lib/native";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  initialResult,
  mergeTitles,
  resolutionText,
  type Resolution,
  type ResultConflict,
} from "./lib/conflictMerge";
import { resolveLanguage } from "./lib/languageResolver";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";

type Props = {
  active: boolean;
  repoRoot: string;
  path: string;
  /** Called after the result is written and staged, so the source-control
   * panel and open editor baselines can refresh. */
  onResolved?: (repoRoot: string, path: string) => void;
};

type Versions = Pick<GitMergeVersions, "ours" | "theirs" | "base" | "merged">;

/** Drops the conflict at an index once a resolution replaced its text. */
const resolvedConflict = StateEffect.define<number>();

function resolveConflict(view: EditorView, index: number, how: Resolution) {
  const c = view.state.field(conflictField).conflicts[index];
  if (!c) return;
  view.dispatch({
    changes: { from: c.from, to: c.to, insert: resolutionText(c, how) },
    effects: resolvedConflict.of(index),
    userEvent: "input.resolve",
  });
}

class ActionsWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly hasBase: boolean,
  ) {
    super();
  }
  eq(o: ActionsWidget) {
    return o.index === this.index && o.hasBase === this.hasBase;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-conflict-actions";
    const add = (label: string, how: Resolution) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      // Keep the caret / focus in the editor; resolve on click (mouse or keyboard).
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = (e) => {
        e.preventDefault();
        resolveConflict(view, this.index, how);
      };
      el.appendChild(b);
    };
    const title = document.createElement("span");
    title.textContent = `Conflict ${this.index + 1}`;
    el.appendChild(title);
    add("Accept Yours", "ours");
    add("Accept Theirs", "theirs");
    add("Accept Both", "both");
    if (this.hasBase) add("Use Base", "base");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

const conflictLine = Decoration.line({ class: "cm-conflict-marker" });

function decorate(
  state: EditorState,
  conflicts: readonly ResultConflict[],
): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  conflicts.forEach((c, i) => {
    b.add(
      c.from,
      c.from,
      Decoration.widget({
        widget: new ActionsWidget(i, c.base !== null),
        block: true,
        side: -1,
      }),
    );
    if (c.to <= c.from) return;
    const endLine = doc.lineAt(c.to - 1).number;
    for (let n = doc.lineAt(c.from).number; n <= endLine; n++)
      b.add(doc.line(n).from, doc.line(n).from, conflictLine);
  });
  return b.finish();
}

/**
 * The result's unresolved conflicts, tracked as ranges holding the base text
 * (no markers), as IDEA's merge dialog shows them. Typing at a conflict's edges
 * stays in it.
 */
const conflictField = StateField.define<{
  conflicts: ResultConflict[];
  deco: DecorationSet;
}>({
  create: () => ({ conflicts: [], deco: Decoration.none }),
  update(v, tr) {
    const done = new Set(
      tr.effects
        .filter((e) => e.is(resolvedConflict))
        .map((e) => e.value as number),
    );
    let conflicts = v.conflicts.filter((_, i) => !done.has(i));
    if (tr.docChanged)
      conflicts = conflicts.map((c) => ({
        ...c,
        from: tr.changes.mapPos(c.from, -1),
        to: tr.changes.mapPos(c.to, 1),
      }));
    if (!tr.docChanged && !done.size) return v;
    return { conflicts, deco: decorate(tr.state, conflicts) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const resultTheme = EditorView.baseTheme({
  ".cm-conflict-marker": {
    backgroundColor: "color-mix(in srgb, var(--destructive) 12%, transparent)",
    color: "var(--muted-foreground)",
  },
  ".cm-conflict-actions": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "3px 8px",
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    color: "var(--destructive)",
    background: "var(--bg-elev, var(--muted))",
    borderTop: "1px solid var(--border)",
  },
  ".cm-conflict-actions button": {
    padding: "0 6px",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    color: "var(--muted-foreground)",
    background: "var(--popover)",
    font: "inherit",
    lineHeight: "18px",
    cursor: "pointer",
  },
  ".cm-conflict-actions button:hover": {
    color: "var(--foreground)",
    background: "var(--accent)",
  },
});

/** Read-only side editor: the pane's text diffed against the common base. */
function sideExtensions(
  lang: Extension,
  base: string | null,
  theme: Extension,
): Extension[] {
  const ext: Extension[] = [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    lang,
    theme,
  ];
  if (base !== null) {
    ext.push(
      unifiedMergeView({
        original: base,
        mergeControls: false,
        gutter: true,
      }),
    );
  }
  return ext;
}

export function ConflictMergePane({
  active,
  repoRoot,
  path,
  onResolved,
}: Props) {
  const { t } = useTranslation();
  const themeExt = useEditorThemeExt();
  const oursRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const resultView = useRef<EditorView | null>(null);
  const [versions, setVersions] = useState<Versions | null>(null);
  const [sides, setSides] = useState<GitMergeSides | null>(null);
  const [lang, setLang] = useState<Extension | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [resolved, setResolved] = useState(false);
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    setResolved(false);
    try {
      const v = await native.gitConflictVersions(repoRoot, path);
      setVersions({
        ours: v.ours ?? "",
        theirs: v.theirs ?? "",
        base: v.base,
        merged: v.merged,
      });
      setSides(v.sides);
      setStatus("ready");
    } catch (e) {
      setError(String(e));
      setStatus("error");
    }
  }, [repoRoot, path]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  useEffect(() => {
    let alive = true;
    void resolveLanguage(path).then((l) => {
      if (alive) setLang(l?.ext ?? []);
    });
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    if (
      !versions ||
      lang === null ||
      status !== "ready" ||
      !oursRef.current ||
      !resultRef.current ||
      !theirsRef.current
    )
      return;
    const ours = new EditorView({
      doc: versions.ours ?? "",
      parent: oursRef.current,
      extensions: sideExtensions(lang, versions.base, themeExt),
    });
    const theirs = new EditorView({
      doc: versions.theirs ?? "",
      parent: theirsRef.current,
      extensions: sideExtensions(lang, versions.base, themeExt),
    });
    // Like IDEA, start from the three-way merge (non-conflicting changes
    // applied, conflicts showing the base) rather than the marker-laden
    // working copy.
    const start =
      versions.merged !== null
        ? initialResult(versions.merged)
        : { text: versions.ours ?? "", conflicts: [] as ResultConflict[] };
    const result = new EditorView({
      doc: start.text,
      parent: resultRef.current,
      extensions: [
        history(),
        keymap.of(historyKeymap),
        lang,
        themeExt,
        conflictField.init((s) => ({
          conflicts: start.conflicts,
          deco: decorate(s, start.conflicts),
        })),
        resultTheme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged)
            setLeft(u.state.field(conflictField).conflicts.length);
        }),
      ],
    });
    resultView.current = result;
    setLeft(result.state.field(conflictField).conflicts.length);
    return () => {
      ours.destroy();
      theirs.destroy();
      result.destroy();
      resultView.current = null;
    };
    // Rebuild only when the fetched content or language changes.
     
  }, [versions, lang, status, themeExt]);

  const goto = useCallback((dir: 1 | -1) => {
    const v = resultView.current;
    if (!v) return;
    const blocks = v.state.field(conflictField).conflicts;
    if (!blocks.length) return;
    const head = v.state.selection.main.head;
    const target =
      dir === 1
        ? (blocks.find((b) => b.from > head) ?? blocks[0]!)
        : ([...blocks].reverse().find((b) => b.to < head) ??
          blocks[blocks.length - 1]!);
    v.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
    v.focus();
  }, []);

  const acceptAll = useCallback((how: Resolution) => {
    const v = resultView.current;
    if (!v) return;
    const conflicts = v.state.field(conflictField).conflicts;
    v.dispatch({
      changes: conflicts.map((c) => ({
        from: c.from,
        to: c.to,
        insert: resolutionText(c, how),
      })),
      effects: conflicts.map((_, i) => resolvedConflict.of(i)),
      userEvent: "input.resolve",
    });
  }, []);

  const apply = useCallback(async () => {
    const v = resultView.current;
    if (!v || applying) return;
    setApplying(true);
    try {
      const text = v.state.doc.toString();
      await native.gitConflictResolve(repoRoot, path, text);
      setResolved(true);
      toast.success(t("editor.conflictResolved"));
      onResolved?.(repoRoot, path);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setApplying(false);
    }
  }, [applying, repoRoot, path, t, onResolved]);

  const titles = mergeTitles(sides);
  const ready = status === "ready" && versions !== null && lang !== null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="outline"
            className="text-[10px] uppercase tracking-wide"
          >
            {t("editor.conflictUnresolved")}
          </Badge>
          <span
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={path}
          >
            {path}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[10.5px] text-muted-foreground">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => goto(-1)}
            aria-label="Previous conflict"
          >
            <HugeiconsIcon icon={ArrowUp01Icon} size={12} strokeWidth={2} />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => goto(1)}
            aria-label="Next conflict"
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={12} strokeWidth={2} />
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void load()}
            aria-label="Reload from disk"
          >
            <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={2} />
          </Button>
          <span
            className={cn(
              "whitespace-nowrap",
              left === 0 ? "text-muted-foreground" : "text-destructive",
            )}
          >
            {left === 0
              ? t("editor.conflictAllResolved")
              : t("editor.conflictCount", { count: left })}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={applying || !ready}
            onClick={() => acceptAll("ours")}
          >
            {t("editor.conflictAcceptAllYours")}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={applying || !ready}
            onClick={() => acceptAll("theirs")}
          >
            {t("editor.conflictAcceptAllTheirs")}
          </Button>
          <Button
            size="xs"
            variant="default"
            disabled={applying || !ready}
            onClick={() => void apply()}
          >
            {t("editor.conflictApply")}
          </Button>
        </div>
      </div>

      {status === "error" ? (
        <div className="flex flex-1 items-center justify-center gap-3 text-[11.5px] text-destructive">
          <span>{error ?? "Failed to load conflict versions"}</span>
          <Button size="xs" variant="outline" onClick={() => void load()}>
            {t("editor.conflictRetry")}
          </Button>
        </div>
      ) : resolved ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[12px] text-muted-foreground">
          <span>{t("editor.conflictResolvedDone")}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            {t("editor.conflictReviewAgain")}
          </Button>
        </div>
      ) : (
        <>
          {ready ? (
            <div className="grid shrink-0 grid-cols-3 border-b border-border/60 text-[10.5px] text-muted-foreground">
              <span className="flex items-center px-3 py-1.5">
                {titles.yours}
              </span>
              <span className="flex items-center border-l border-border/60 px-3 py-1.5">
                {t("editor.conflictResult")}
              </span>
              <span className="flex items-center border-l border-border/60 px-3 py-1.5">
                {titles.theirs}
              </span>
            </div>
          ) : null}
          <div className="relative min-h-0 flex-1 overflow-hidden">
            {!ready ? (
              <div className="flex h-full items-center justify-center">
                <Spinner className="size-4" />
              </div>
            ) : (
              <div className="grid h-full grid-cols-3 divide-x divide-border/60">
                <div
                  ref={oursRef}
                  className="min-w-0 min-h-0 overflow-hidden"
                  aria-label="Your version"
                  role="region"
                />
                <div
                  ref={resultRef}
                  className="min-w-0 min-h-0 overflow-hidden"
                  aria-label="Result"
                  role="region"
                />
                <div
                  ref={theirsRef}
                  className="min-w-0 min-h-0 overflow-hidden"
                  aria-label="Their version"
                  role="region"
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
