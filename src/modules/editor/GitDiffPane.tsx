import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { getChunks, MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type GitHunk, native } from "@/modules/ai/lib/native";
import {
  commitDiffKey,
  fetchCommitDiff,
  fetchWorkingDiff,
  getCachedDiff,
  workingDiffKey,
} from "./lib/diffCache";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  languageCompartment,
} from "./lib/extensions";
import { fetchWorkingHunks, invalidateWorkingDiff } from "./lib/diffCache";
import { resolveLanguage, resolveLanguageSync } from "./lib/languageResolver";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { DiffViewToggle } from "./DiffViewToggle";
import { DEFAULT_DIFF_MODE, type DiffMode } from "./diffMode";
import { DiffOverview } from "./DiffOverview";
import {
  hunkCheckGutter,
  type RulerMark,
  rulerMarks,
  setHunksEffect,
} from "./lib/diffHunkMarkers";
import { changedLines } from "./lib/modifiedLines";

type WorkingSource = {
  kind: "working";
  repoRoot: string;
  path: string;
  mode: "-" | "+";
  originalPath: string | null;
};

type CommitSource = {
  kind: "commit";
  repoRoot: string;
  sha: string;
  path: string;
  originalPath: string | null;
};

type Props = {
  source: WorkingSource | CommitSource;
  chipLabel?: string;
  active: boolean;
  /** Called after a hunk-level stage/discard changes the index or worktree,
   * so the source-control panel and open editor baselines can refresh. */
  onHunkStaged?: (repoRoot: string, path: string) => void;
};

const LARGE_FILE_THRESHOLD = 256 * 1024;

const SHARED_EXT = buildSharedExtensions();
const READONLY_EXT = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
];
const DIFF_THEME = EditorView.theme({
  "&.cm-merge-b .cm-changedText, .cm-changedText": {
    background: "rgba(110, 200, 120, 0.20) !important",
    borderRadius: "3px",
    padding: "0 1px",
  },
  ".cm-deletedChunk .cm-deletedText, &.cm-merge-b .cm-deletedText": {
    background: "rgba(220, 90, 90, 0.22) !important",
    borderRadius: "3px",
    padding: "0 1px",
  },
  "&.cm-merge-b .cm-changedLine, .cm-changedLine, .cm-inlineChangedLine": {
    backgroundColor: "rgba(110, 200, 120, 0.05) !important",
  },
  ".cm-deletedChunk": {
    backgroundColor: "rgba(220, 90, 90, 0.05) !important",
    paddingTop: "1px",
    paddingBottom: "1px",
  },
  "&.cm-merge-b .cm-changedLineGutter, .cm-changedLineGutter": {
    background: "rgba(110, 200, 120, 0.55) !important",
  },
  ".cm-deletedLineGutter, &.cm-merge-a .cm-changedLineGutter": {
    background: "rgba(220, 90, 90, 0.5) !important",
  },
  ".cm-changeGutter": {
    width: "2px !important",
    paddingLeft: "0 !important",
  },
  ".cm-collapsedLines": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground, #9ca3af)",
    fontSize: "10.5px",
    padding: "2px 8px",
    opacity: 0.7,
  },
});

function countDiffLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (let i = 0; i < patch.length; i++) {
    if (i > 0 && patch.charCodeAt(i - 1) !== 10) continue;
    const c = patch.charCodeAt(i);
    if (c === 43 && patch.charCodeAt(i + 1) !== 43) added++;
    else if (c === 45 && patch.charCodeAt(i + 1) !== 45) removed++;
  }
  if (patch.length > 0 && patch.charCodeAt(0) === 43) added++;
  else if (patch.length > 0 && patch.charCodeAt(0) === 45) removed++;
  return { added, removed };
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "loaded";
      originalContent: string;
      modifiedContent: string;
      isBinary: boolean;
      fallbackPatch: string;
      /** Resolved before mount: a late compartment reconfigure would leave
       * the merge view's deleted-chunk widgets unhighlighted. */
      langExt: Extension | null;
    }
  | { kind: "error"; message: string };

function cacheKey(source: WorkingSource | CommitSource): string {
  if (source.kind === "working") {
    return workingDiffKey(source.repoRoot, source.path, source.mode);
  }
  return commitDiffKey(source.repoRoot, source.sha, source.path);
}

function loadStateFromCache(source: WorkingSource | CommitSource): LoadState {
  const hit = getCachedDiff(cacheKey(source));
  if (!hit) return { kind: "idle" };
  return {
    kind: "loaded",
    originalContent: hit.originalContent,
    modifiedContent: hit.modifiedContent,
    isBinary: hit.isBinary,
    fallbackPatch: hit.fallbackPatch,
    langExt: resolveLanguageSync(source.path)?.ext ?? null,
  };
}

export function GitDiffPane({
  source,
  chipLabel,
  active,
  onHunkStaged,
}: Props) {
  const { t } = useTranslation();
  const cmRef = useRef<ReactCodeMirrorRef>(null);
  const mergeRootRef = useRef<HTMLDivElement | null>(null);
  const mergeViewRef = useRef<MergeView | null>(null);
  const themeExt = useEditorThemeExt();
  const gitDiffCollapseUnchanged = usePreferencesStore(
    (s) => s.gitDiffCollapseUnchanged,
  );
  const [diffMode, setDiffMode] = useState<DiffMode>(DEFAULT_DIFF_MODE);
  const [state, setState] = useState<LoadState>(() =>
    active ? loadStateFromCache(source) : { kind: "idle" },
  );
  const [hunks, setHunks] = useState<GitHunk[]>([]);
  const [busyHunk, setBusyHunk] = useState<number | null>(null);
  // Latest hunks for imperative dispatch into a freshly created view, where a
  // state effect may not have run yet.
  const hunksRef = useRef<GitHunk[]>([]);

  const key = cacheKey(source);

  // Hunk-level staging applies only to a working diff (a conflict opens the
  // three-pane merge editor instead). Fetch the parsed hunks once the content
  // is known, so the checkbox column can offer one box per hunk. A commit diff
  // has no stage-able hunks.
  const isWorkingDiff = source.kind === "working";
  const staged = source.kind === "working" ? source.mode === "+" : false;
  useEffect(() => {
    if (!active || !isWorkingDiff) return;
    let cancelled = false;
    setHunks([]);
    hunksRef.current = [];
    void fetchWorkingHunks(source.repoRoot, source.path, staged).then((h) => {
      if (cancelled) return;
      setHunks(h);
      hunksRef.current = h;
    });
    return () => {
      cancelled = true;
    };
  }, [active, isWorkingDiff, source.repoRoot, source.path, staged, key]);

  /** Stage or unstage a single hunk, then invalidate caches, re-fetch the
   * remaining hunks so the checkbox column tracks the new index state, and
   * notify the panel/editor to refresh. `discard` un-stages a staged hunk;
   * otherwise it stages an unstaged hunk. */
  const handleHunk = useCallback(
    async (index: number, discard: boolean) => {
      setBusyHunk(index);
      try {
        if (discard) {
          await native.gitResetHunks(source.repoRoot, source.path, [index]);
        } else {
          await native.gitStageHunks(source.repoRoot, source.path, [index]);
        }
        invalidateWorkingDiff(source.repoRoot, source.path);
        onHunkStaged?.(source.repoRoot, source.path);
        const next = await fetchWorkingHunks(
          source.repoRoot,
          source.path,
          staged,
        );
        setHunks(next);
        hunksRef.current = next;
      } catch (e) {
        toast.error(String(e));
      } finally {
        setBusyHunk(null);
      }
    },
    [source.repoRoot, source.path, staged, onHunkStaged],
  );

  /** Clicking a hunk checkbox from anywhere in the pane. */
  const handlePaneClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (busyHunk !== null) return;
      const el = (e.target as HTMLElement).closest("[data-hunk-idx]");
      if (!el) return;
      const idx = Number(el.getAttribute("data-hunk-idx"));
      if (Number.isInteger(idx) && idx >= 0) void handleHunk(idx, staged);
    },
    [busyHunk, handleHunk, staged],
  );

  useEffect(() => {
    if (!active) return;
    const cached = loadStateFromCache(source);
    if (cached.kind === "loaded") {
      setState(cached);
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    const promise =
      source.kind === "working"
        ? fetchWorkingDiff(
            source.repoRoot,
            source.path,
            source.mode,
            source.originalPath,
          )
        : fetchCommitDiff(
            source.repoRoot,
            source.sha,
            source.path,
            source.originalPath,
          );
    Promise.all([promise, resolveLanguage(source.path).catch(() => null)])
      .then(([res, lang]) => {
        if (cancelled) return;
        setState({
          kind: "loaded",
          originalContent: res.originalContent,
          modifiedContent: res.modifiedContent,
          isBinary: res.isBinary,
          fallbackPatch: res.fallbackPatch,
          langExt: lang?.ext ?? null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message:
            err && typeof err === "object" && "message" in err
              ? String((err as { message: unknown }).message)
              : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [active, key, source]);

  const path = source.path;
  const repoRoot = source.repoRoot;
  const mode = source.kind === "working" ? source.mode : "+";
  const loaded = state.kind === "loaded" ? state : null;
  const originalContent = loaded?.originalContent ?? "";
  const modifiedContent = loaded?.modifiedContent ?? "";
  const isBinary = loaded?.isBinary ?? false;
  const fallbackPatch = loaded?.fallbackPatch ?? "";

  const isTooLarge =
    originalContent.length > LARGE_FILE_THRESHOLD ||
    modifiedContent.length > LARGE_FILE_THRESHOLD;
  const useFallback = isBinary || isTooLarge;

  const langExt = loaded?.langExt ?? null;
  // "Collapse unchanged" only when the setting is on; off (default) shows all
  // lines. Pass undefined (not {}) so the merge view leaves folding disabled.
  const collapseUnchanged = gitDiffCollapseUnchanged
    ? { margin: 3, minSize: 6 }
    : undefined;

  const extensions = useMemo(
    () => [
      ...SHARED_EXT,
      DEFAULT_INDENT,
      languageCompartment.of(langExt ?? []),
      ...READONLY_EXT,
      unifiedMergeView({
        original: originalContent,
        mergeControls: false,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        collapseUnchanged,
      }),
      ...(isWorkingDiff
        ? [
            hunkCheckGutter(
              {
                stage: t("editor.diffStageHunk"),
                unstage: t("editor.diffUnstageHunk"),
              },
              staged,
            ),
          ]
        : []),
      DIFF_THEME,
    ],
    [
      originalContent,
      langExt,
      gitDiffCollapseUnchanged,
      isWorkingDiff,
      staged,
      t,
    ],
  );

  // Cache-hit path only: the diff came from the cache before the language
  // pack was imported. Resolve and reconfigure once the view exists.
  useEffect(() => {
    if (useFallback || state.kind !== "loaded" || state.langExt) return;
    let cancelled = false;
    resolveLanguage(path).then((res) => {
      if (cancelled || !res) return;
      setState((s) => (s.kind === "loaded" ? { ...s, langExt: res.ext } : s));
    });
    return () => {
      cancelled = true;
    };
  }, [useFallback, path, state]);

  // Split view: build a two-pane merge (a = original, b = modified) imperatively.
  const splitReady =
    state.kind === "loaded" && !useFallback && diffMode === "split";
  useEffect(() => {
    if (!splitReady || !mergeRootRef.current) return;
    const root = mergeRootRef.current;
    const splitExts: Extension[] = [
      ...SHARED_EXT,
      DEFAULT_INDENT,
      languageCompartment.of(langExt ?? []),
      ...READONLY_EXT,
      DIFF_THEME,
      themeExt,
    ];
    const splitExtsB: Extension[] = [
      ...splitExts,
      ...(isWorkingDiff
        ? [
            hunkCheckGutter(
              {
                stage: t("editor.diffStageHunk"),
                unstage: t("editor.diffUnstageHunk"),
              },
              staged,
            ),
          ]
        : []),
    ];
    const view = new MergeView({
      a: { doc: originalContent, extensions: splitExts },
      b: { doc: modifiedContent, extensions: splitExtsB },
      parent: root,
      gutter: true,
      highlightChanges: true,
      collapseUnchanged,
    });
    const dom = view.dom;
    dom.style.height = "100%";
    dom.style.overflow = "auto";
    mergeViewRef.current = view;
    if (hunksRef.current.length > 0) {
      view.b.dispatch({ effects: setHunksEffect.of(hunksRef.current) });
    }
    return () => {
      view.destroy();
      root.innerHTML = "";
      mergeViewRef.current = null;
    };
  }, [
    splitReady,
    originalContent,
    modifiedContent,
    langExt,
    themeExt,
    gitDiffCollapseUnchanged,
    isWorkingDiff,
    staged,
    t,
  ]);

  // Push freshly fetched hunks into the checkbox gutter of whichever view is
  // current. The split view dispatches during construction (above); this covers
  // the unified view and hunks that arrive after the split editor exists, and
  // the empty case that clears the boxes once the last hunk is staged (the diff
  // content itself is unchanged by staging, so the editor may not rebuild).
  useEffect(() => {
    const view =
      diffMode === "split" ? mergeViewRef.current?.b : cmRef.current?.view;
    if (!view) return;
    view.dispatch({ effects: setHunksEffect.of(hunks) });
  }, [hunks, diffMode, splitReady, state.kind]);

  // Right-edge overview ruler: derive the B-side changed bands from the merge
  // chunks of the active view. The diff is read-only and loaded once, so this
  // recomputes only when the view or content is replaced.
  const [overview, setOverview] = useState<{
    marks: RulerMark[];
    totalLines: number;
  } | null>(null);
  useEffect(() => {
    if (useFallback) {
      setOverview(null);
      return;
    }
    const view =
      diffMode === "split" ? mergeViewRef.current?.b : cmRef.current?.view;
    if (!view) return;
    const chunks =
      diffMode === "split"
        ? (mergeViewRef.current?.chunks ?? [])
        : (getChunks(view.state)?.chunks ?? []);
    const doc = view.state.doc;
    setOverview({
      marks: rulerMarks(changedLines(chunks, doc), doc.lines),
      totalLines: doc.lines,
    });
  }, [
    diffMode,
    splitReady,
    originalContent,
    modifiedContent,
    langExt,
    themeExt,
    gitDiffCollapseUnchanged,
    useFallback,
  ]);

  const jumpToLine = useCallback(
    (line: number) => {
      const view =
        diffMode === "split" ? mergeViewRef.current?.b : cmRef.current?.view;
      if (!view) return;
      const maxLine = view.state.doc.lines;
      const target = Math.max(1, Math.min(line, maxLine));
      const pos = view.state.doc.line(target).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start" }),
      });
    },
    [diffMode],
  );

  const stats = useMemo(
    () =>
      useFallback ? countDiffLines(fallbackPatch) : { added: 0, removed: 0 },
    [useFallback, fallbackPatch],
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-background"
      onClick={handlePaneClick}
    >
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="outline"
            className="text-[10px] uppercase tracking-wide"
          >
            {chipLabel ?? mode}
          </Badge>
          {isBinary ? (
            <Badge variant="secondary" className="text-[10px]">
              Binary / patch fallback
            </Badge>
          ) : isTooLarge ? (
            <Badge variant="secondary" className="text-[10px]">
              Large file / patch view
            </Badge>
          ) : null}
          <span
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={path}
          >
            {path}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[10.5px] tabular-nums text-muted-foreground">
          <span className="truncate max-w-80 font-mono">{repoRoot}</span>
          {useFallback ? (
            <>
              <span className="text-emerald-600 dark:text-emerald-400">
                +{stats.added}
              </span>
              <span className="text-rose-600 dark:text-rose-400">
                −{stats.removed}
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {loaded && !useFallback ? (
          <DiffViewToggle mode={diffMode} onChange={setDiffMode} />
        ) : null}
        {loaded && !useFallback && overview ? (
          <DiffOverview
            totalLines={overview.totalLines}
            marks={overview.marks}
            onJump={jumpToLine}
          />
        ) : null}
        {state.kind === "loading" || state.kind === "idle" ? (
          <div className="flex h-full items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            Loading diff…
          </div>
        ) : state.kind === "error" ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-[11.5px] text-destructive">
            {state.message}
          </div>
        ) : useFallback ? (
          <ScrollArea className="h-full">
            <pre className="min-h-full whitespace-pre-wrap wrap-break-word p-4 font-mono text-[12px] leading-relaxed text-muted-foreground">
              {fallbackPatch || t("editor.diffPreviewUnavailable")}
            </pre>
          </ScrollArea>
        ) : diffMode === "split" ? (
          <div ref={mergeRootRef} className="h-full" />
        ) : (
          <CodeMirror
            ref={cmRef}
            value={modifiedContent}
            theme={themeExt}
            extensions={extensions}
            editable={false}
            height="100%"
            className="h-full"
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
              searchKeymap: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
