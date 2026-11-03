import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
  MergeView,
  unifiedMergeView,
  uncollapseUnchanged,
} from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
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
  fetchWorkingHunks,
  getCachedDiff,
  invalidateDiff,
  invalidateWorkingDiff,
  workingDiffKey,
} from "./lib/diffCache";
import {
  buildSharedExtensions,
  DEFAULT_INDENT,
  languageCompartment,
} from "./lib/extensions";
import { resolveLanguage, resolveLanguageSync } from "./lib/languageResolver";
import { useEditorThemeExt } from "./lib/useEditorThemeExt";
import { DiffOverview } from "./DiffOverview";
import { DiffToolbar } from "./DiffToolbar";
import { currentChunkIndex, ideaDiffPane } from "./lib/diffIdea";
import {
  highlightsWords,
  loadDiffViewerOptions,
  readDiffViewerOptions,
  saveDiffViewerOptions,
  type DiffViewerOptions,
} from "./lib/diffOptions";
import { diffConfigFor } from "./lib/diffWhitespace";
import { DiffDivider } from "./lib/diffDivider";
import { SyncedPanes } from "./lib/diffScrollSync";
import {
  hunkCheckGutter,
  type RulerMark,
  rulerMarks,
  setHunksEffect,
} from "./lib/diffHunkMarkers";
import { changedLines } from "./lib/modifiedLines";
import { requestJumpToSource } from "./lib/jumpToSource";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setGitDiffCollapseUnchanged } from "@/modules/settings/store";

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
  // A read-only revision pane still needs keyboard selection and copy.
  EditorView.contentAttributes.of({ tabindex: "0" }),
];

/**
 * IDEA's colours, driven by the diff-pane classes `ideaDiffPane` emits: whole
 * changed lines, their line-number gutters, and the inner word fragments in the
 * full colour of the fragment's own change type.
 */
const DIFF_THEME = EditorView.theme({
  // The engine still marks chunks itself (`cm-changedLine`); IDEA paints the
  // lines from the chunk type below, so that default tint is turned off.
  "&.cm-merge-a .cm-changedLine, &.cm-merge-b .cm-changedLine": {
    backgroundColor: "transparent",
  },
  // Changed lines: opaque enough to read as a block, translucent so the
  // selection layer beneath still shows through.
  ".cm-line.cm-diffLine-modified": {
    backgroundColor: "color-mix(in srgb, var(--ml-modified) 14%, transparent)",
  },
  ".cm-line.cm-diffLine-inserted": {
    backgroundColor: "color-mix(in srgb, var(--ml-added) 14%, transparent)",
  },
  ".cm-line.cm-diffLine-deleted": {
    backgroundColor: "color-mix(in srgb, var(--ml-deleted) 14%, transparent)",
  },
  // Chunks whose words were compared take the lighter colour; their fragments
  // below carry the full one (TextDiffType.getIgnoredColor).
  ".cm-line.cm-diffLine-fine.cm-diffLine-modified": {
    backgroundColor: "color-mix(in srgb, var(--ml-modified) 8%, transparent)",
  },
  ".cm-line.cm-diffLine-fine.cm-diffLine-inserted": {
    backgroundColor: "color-mix(in srgb, var(--ml-added) 8%, transparent)",
  },
  ".cm-line.cm-diffLine-fine.cm-diffLine-deleted": {
    backgroundColor: "color-mix(in srgb, var(--ml-deleted) 8%, transparent)",
  },
  // The line-number column shares the line colour, so the tint reads as one
  // block across the gutter and the text.
  ".cm-diffGutter-modified": {
    backgroundColor: "color-mix(in srgb, var(--ml-modified) 30%, transparent)",
  },
  ".cm-diffGutter-inserted": {
    backgroundColor: "color-mix(in srgb, var(--ml-added) 30%, transparent)",
  },
  ".cm-diffGutter-deleted": {
    backgroundColor: "color-mix(in srgb, var(--ml-deleted) 30%, transparent)",
  },
  ".cm-diffGutter-fine.cm-diffGutter-modified": {
    backgroundColor: "color-mix(in srgb, var(--ml-modified) 16%, transparent)",
  },
  ".cm-diffGutter-fine.cm-diffGutter-inserted": {
    backgroundColor: "color-mix(in srgb, var(--ml-added) 16%, transparent)",
  },
  ".cm-diffGutter-fine.cm-diffGutter-deleted": {
    backgroundColor: "color-mix(in srgb, var(--ml-deleted) 16%, transparent)",
  },
  // Full line height: an inline background only covers the font's height,
  // leaving stripes between the lines of a multi-line fragment.
  ".cm-diffWord": { display: "inline-block" },
  ".cm-diffWord-modified": {
    backgroundColor: "color-mix(in srgb, var(--ml-modified) 45%, transparent)",
  },
  ".cm-diffWord-inserted": {
    backgroundColor: "color-mix(in srgb, var(--ml-added) 45%, transparent)",
  },
  ".cm-diffWord-deleted": {
    backgroundColor: "color-mix(in srgb, var(--ml-deleted) 45%, transparent)",
  },
  // A word present on the other side only: a thin bar where it would be.
  ".cm-diffWordEmpty": {
    display: "inline-block",
    width: "2px",
    height: "1lh",
    margin: "0 -1px",
    verticalAlign: "top",
  },
  // Where the other pane has rows this one lacks, a rule above the boundary.
  ".cm-line.cm-diffGap-inserted": {
    boxShadow: "inset 0 1px 0 var(--ml-added)",
  },
  ".cm-line.cm-diffGap-deleted": {
    boxShadow: "inset 0 1px 0 var(--ml-deleted)",
  },
  ".cm-line.cm-diffGap-inserted.cm-diffGapEnd": {
    boxShadow: "inset 0 -1px 0 var(--ml-added)",
  },
  ".cm-line.cm-diffGap-deleted.cm-diffGapEnd": {
    boxShadow: "inset 0 -1px 0 var(--ml-deleted)",
  },
  // The unified viewer paints its own rows (engine decorations).
  ".cm-inlineChangedLine": {
    backgroundColor: "color-mix(in srgb, var(--ml-added) 14%, transparent)",
  },
  ".cm-deletedChunk": {
    backgroundColor: "color-mix(in srgb, var(--ml-deleted) 10%, transparent)",
    paddingTop: "0",
    paddingBottom: "0",
  },
  ".cm-deletedChunk .cm-deletedText, &.cm-merge-a .cm-changedText": {
    backgroundColor: "color-mix(in srgb, var(--ml-deleted) 45%, transparent)",
    borderRadius: "2px",
  },
  "&.cm-merge-b .cm-changedText, .cm-changedText": {
    backgroundColor: "color-mix(in srgb, var(--ml-added) 45%, transparent)",
    borderRadius: "2px",
  },
  // The divider between unpadded panes: a thin rail the bands are drawn on.
  ".cm-diffDivider": {
    position: "relative",
    flex: "none",
    width: "30px",
    overflow: "hidden",
    backgroundColor: "var(--background)",
    borderLeft: "1px solid var(--border)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-diffDivider svg": { position: "absolute", inset: "0" },
  ".cm-diffBand": { opacity: "0.3" },
  ".cm-diffBand-inserted": { fill: "var(--ml-added)" },
  ".cm-diffBand-deleted": { fill: "var(--ml-deleted)" },
  ".cm-diffBand-modified": { fill: "var(--ml-modified)" },
  ".cm-diffBandLine": { fill: "none", strokeWidth: "1px" },
  ".cm-diffBandLine.cm-diffBand-inserted": { stroke: "var(--ml-added)" },
  ".cm-diffBandLine.cm-diffBand-deleted": { stroke: "var(--ml-deleted)" },
  ".cm-diffBandLine.cm-diffBand-modified": { stroke: "var(--ml-modified)" },
  // IDEA's collapsed-fragment row: no ⦚ ornaments, a quiet one-line label.
  ".cm-collapsedLines": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    fontFamily: "var(--font-sans, inherit)",
    fontSize: "10.5px",
    padding: "1px 8px",
    cursor: "pointer",
    opacity: 0.75,
  },
  ".cm-collapsedLines:before, .cm-collapsedLines:after": { content: "none" },
});

/** "Do not highlight" strips both the line paints and the word fragments. */
const NO_HIGHLIGHT_THEME = EditorView.theme({
  ".cm-line.cm-diffLine, .cm-diffGutter, .cm-changedLine, .cm-changedText": {
    backgroundColor: "transparent !important",
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
  const syncRef = useRef<SyncedPanes | null>(null);
  const themeExt = useEditorThemeExt();

  const [options, setOptions] = useState<DiffViewerOptions>(() =>
    loadDiffViewerOptions(),
  );
  // Read once when the panes are built; later toggles go through setEnabled.
  const syncEnabledRef = useRef(options.syncScroll);
  syncEnabledRef.current = options.syncScroll;
  const gitDiffCollapseUnchanged = usePreferencesStore(
    (s) => s.gitDiffCollapseUnchanged,
  );
  const patchOptions = useCallback((patch: Partial<DiffViewerOptions>) => {
    // "Collapse unchanged fragments" is also a Settings switch; write the
    // preference so both surfaces agree (and the other panes follow).
    if (patch.collapse !== undefined)
      void setGitDiffCollapseUnchanged(patch.collapse);
    setOptions((current) => {
      const next = { ...current, ...patch };
      saveDiffViewerOptions(next);
      return next;
    });
  }, []);
  const diffMode = options.mode;

  const [state, setState] = useState<LoadState>(() =>
    active ? loadStateFromCache(source) : { kind: "idle" },
  );
  const [hunks, setHunks] = useState<GitHunk[]>([]);
  const [busyHunk, setBusyHunk] = useState<number | null>(null);
  // Latest hunks for imperative dispatch into a freshly created view, where a
  // state effect may not have run yet.
  const hunksRef = useRef<GitHunk[]>([]);

  const key = cacheKey(source);

  // Viewer options are shared by every open diff pane (IDEA stores them per
  // app). A viewer that was never configured inherits the collapse preference,
  // and later flips of that Settings switch are followed (see below).
  const lastCollapsePref = useRef(gitDiffCollapseUnchanged);
  useEffect(() => {
    const stored = readDiffViewerOptions();
    setOptions((current) =>
      stored
        ? { ...current, ...stored }
        : { ...current, collapse: gitDiffCollapseUnchanged },
    );
    // Seed once per mount; later edits come through `patchOptions`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The Settings switch can flip while a diff is open: adopt the new value.
  useEffect(() => {
    if (lastCollapsePref.current === gitDiffCollapseUnchanged) return;
    lastCollapsePref.current = gitDiffCollapseUnchanged;
    setOptions((current) => {
      const next = { ...current, collapse: gitDiffCollapseUnchanged };
      saveDiffViewerOptions(next);
      return next;
    });
  }, [gitDiffCollapseUnchanged]);

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

  const load = useCallback(() => {
    const cached = loadStateFromCache(source);
    if (cached.kind === "loaded") {
      setState(cached);
      return;
    }
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
        setState({
          kind: "error",
          message:
            err && typeof err === "object" && "message" in err
              ? String((err as { message: unknown }).message)
              : String(err),
        });
      });
  }, [source]);

  const loadFresh = useCallback(() => {
    let cancelled = false;
    invalidateDiff(key);
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
  }, [key, source]);

  useEffect(() => {
    if (!active) return;
    load();
  }, [active, key, load]);

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
  // IDEA's collapse action. Off shows every line. Pass undefined (not {}) so the
  // merge view leaves folding disabled.
  const collapseUnchanged = useMemo(
    () => (options.collapse ? { margin: 3, minSize: 6 } : undefined),
    [options.collapse],
  );
  const diffConfig = diffConfigFor(options.ignore);
  const words = highlightsWords(options.highlight);
  // The IDEA divider only has a meaning when the panes are not padded into
  // alignment; "Align changes" hands padding back to the engine's spacers.
  const unpadded = diffMode === "split" && !options.alignChanges;

  const paneExtensions = useMemo(() => {
    const base: Extension[] = [
      ...SHARED_EXT,
      DEFAULT_INDENT,
      lineNumbers(),
      languageCompartment.of(langExt ?? []),
      ...READONLY_EXT,
      ideaDiffPane({ words, lines: options.highlight !== "none" }),
      DIFF_THEME,
      themeExt,
    ];
    if (options.highlight === "none") base.push(NO_HIGHLIGHT_THEME);
    return base;
  }, [langExt, themeExt, words, options.highlight]);

  const inlineExtensions = useMemo(
    () => [
      ...SHARED_EXT,
      DEFAULT_INDENT,
      languageCompartment.of(langExt ?? []),
      ...READONLY_EXT,
      unifiedMergeView({
        original: originalContent,
        mergeControls: false,
        highlightChanges: words,
        gutter: true,
        syntaxHighlightDeletions: true,
        collapseUnchanged,
        diffConfig,
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
      ...(options.highlight === "none" ? [NO_HIGHLIGHT_THEME] : []),
    ],
    [
      originalContent,
      langExt,
      isWorkingDiff,
      staged,
      t,
      words,
      collapseUnchanged,
      diffConfig,
      options.highlight,
    ],
  );

  // Cache-hit path only: the diff came from the cache before the language pack
  // was imported. Resolve and reconfigure once the view exists.
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

  // Difference counter: the block count of the current view plus the block the
  // cursor sits in. Both are refreshed from the live view, so the toolbar
  // tracks navigation without re-rendering on every keystroke.
  const [diffCount, setDiffCount] = useState(0);
  const [diffIndex, setDiffIndex] = useState(-1);
  const currentView = useCallback((): EditorView | null => {
    return diffMode === "split"
      ? (mergeViewRef.current?.b ?? null)
      : (cmRef.current?.view ?? null);
  }, [diffMode]);
  const refreshCount = useCallback(() => {
    const view = currentView();
    const chunks =
      diffMode === "split"
        ? (mergeViewRef.current?.chunks ?? [])
        : view
          ? (getChunks(view.state)?.chunks ?? [])
          : [];
    setDiffCount(chunks.length);
    setDiffIndex(view ? currentChunkIndex(view) : -1);
  }, [diffMode, currentView]);

  const splitReady =
    state.kind === "loaded" && !useFallback && diffMode === "split";

  useEffect(() => {
    if (!splitReady || !mergeRootRef.current) return;
    const root = mergeRootRef.current;
    const hunksExt = isWorkingDiff
      ? [
          hunkCheckGutter(
            {
              stage: t("editor.diffStageHunk"),
              unstage: t("editor.diffUnstageHunk"),
            },
            staged,
          ),
        ]
      : [];
    const view = new MergeView({
      a: { doc: originalContent, extensions: paneExtensions },
      b: {
        doc: modifiedContent,
        extensions: [
          ...paneExtensions,
          ...hunksExt,
          EditorView.updateListener.of((update) => {
            if (update.selectionSet || update.docChanged) refreshCount();
          }),
        ],
      },
      parent: root,
      // IDEA colours the changes itself (`ideaDiffPane`); the engine's own
      // change bar would double up with the tinted gutter.
      gutter: false,
      highlightChanges: false,
      collapseUnchanged,
      diffConfig,
    });
    root.appendChild(view.dom);
    view.dom.classList.add("terax-diff-merge");
    if (unpadded) {
      root.classList.add("terax-diff-unpadded");
      // MergeView pads the panes into alignment on each measure; unpadded panes
      // keep their own height (IDEA's default) and a divider joins the changes.
      (view as unknown as { measure: () => void }).measure = () => {};
    }
    const panes = { a: view.a, b: view.b, chunks: () => view.chunks };
    let divider: DiffDivider | null = null;
    if (unpadded) {
      divider = new DiffDivider(panes);
      divider.attach(view);
    }
    const sync = new SyncedPanes(panes, syncEnabledRef.current);
    syncRef.current = sync;
    mergeViewRef.current = view;
    if (hunksRef.current.length > 0) {
      view.b.dispatch({ effects: setHunksEffect.of(hunksRef.current) });
    }
    refreshCount();
    return () => {
      sync.destroy();
      syncRef.current = null;
      divider?.destroy();
      view.destroy();
      root.classList.remove("terax-diff-unpadded");
      mergeViewRef.current = null;
      setDiffCount(0);
      setDiffIndex(-1);
    };
  }, [
    splitReady,
    originalContent,
    modifiedContent,
    paneExtensions,
    unpadded,
    isWorkingDiff,
    staged,
    t,
    collapseUnchanged,
    diffConfig,
    refreshCount,
  ]);

  // Scroll sync is a live toggle: the panes already exist, so flip the flag
  // instead of rebuilding them (which would drop the scroll position).
  useEffect(() => {
    syncRef.current?.setEnabled(options.syncScroll);
  }, [options.syncScroll]);

  // Push freshly fetched hunks into the checkbox gutter of whichever view is
  // current. The split view dispatches during construction (above); this covers
  // the unified view and hunks that arrive after the split editor exists, and
  // the empty case that clears the boxes once the last hunk is staged (the diff
  // content itself is unchanged by staging, so the editor may not rebuild).
  useEffect(() => {
    const view = currentView();
    if (!view) return;
    view.dispatch({ effects: setHunksEffect.of(hunks) });
  }, [hunks, diffMode, splitReady, state.kind, currentView]);

  // The unified view's block count lives in its own state; refresh it once the
  // CodeMirror instance exists (and whenever the diff content changes).
  useEffect(() => {
    if (diffMode !== "inline" || useFallback) return;
    const id = requestAnimationFrame(refreshCount);
    return () => cancelAnimationFrame(id);
  }, [diffMode, useFallback, originalContent, modifiedContent, refreshCount]);

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
    const view = currentView();
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
    useFallback,
    currentView,
    options.collapse,
  ]);

  const jumpToLine = useCallback(
    (line: number) => {
      const view = currentView();
      if (!view) return;
      const maxLine = view.state.doc.lines;
      const target = Math.max(1, Math.min(line, maxLine));
      const pos = view.state.doc.line(target).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start" }),
      });
    },
    [currentView],
  );

  /** IDEA's difference navigation: move the cursor to the next/previous block,
   * expanding it first when it sits inside a collapsed stretch. */
  const stepDiff = useCallback(
    (dir: 1 | -1) => {
      const view = currentView();
      if (!view) return;
      const moved = (dir > 0 ? goToNextChunk : goToPreviousChunk)(view);
      if (!moved) return;
      // A collapsed block only reveals itself once its fold is opened.
      const chunks = getChunks(view.state)?.chunks ?? [];
      const index = currentChunkIndex(view);
      const chunk = index >= 0 ? chunks[index] : null;
      const side = getChunks(view.state)?.side ?? "b";
      if (chunk) {
        const [from, to] =
          side === "a" ? [chunk.fromA, chunk.toA] : [chunk.fromB, chunk.toB];
        if (from !== to) {
          const first = view.state.doc.lineAt(from).number;
          const last = view.state.doc.lineAt(Math.max(from, to - 1)).number;
          if (first !== last)
            view.dispatch({ effects: uncollapseUnchanged.of(from) });
        }
      }
      view.focus();
      refreshCount();
    },
    [currentView, refreshCount],
  );

  const jumpToSource = useCallback(() => {
    const view = currentView();
    const line = view
      ? view.state.doc.lineAt(view.state.selection.main.head).number
      : undefined;
    const absolute = `${repoRoot.replace(/[\\/]+$/, "")}/${path}`;
    requestJumpToSource({ path: absolute, line });
  }, [currentView, repoRoot, path]);

  const stats = useMemo(
    () =>
      useFallback ? countDiffLines(fallbackPatch) : { added: 0, removed: 0 },
    [useFallback, fallbackPatch],
  );

  const summaryText = useMemo(() => {
    if (useFallback || state.kind !== "loaded") return "";
    if (diffCount === 0) {
      const identical =
        originalContent.replace(/\r\n/g, "\n") ===
        modifiedContent.replace(/\r\n/g, "\n");
      return t(identical ? "editor.diffIdentical" : "editor.diffNoDifferences");
    }
    if (diffIndex >= 0)
      return t("editor.diffCount", {
        current: diffIndex + 1,
        total: diffCount,
      });
    return diffCount === 1
      ? t("editor.diffCountOne", { total: diffCount })
      : t("editor.diffCountMany", { total: diffCount });
  }, [
    useFallback,
    state.kind,
    diffCount,
    diffIndex,
    originalContent,
    modifiedContent,
    t,
  ]);

  // The pane labels under the toolbar, as IDEA names its two sides.
  const leftLabel = chipLabel
    ? `${t("editor.diffOriginal")} · ${chipLabel}`
    : t("editor.diffOriginal");
  const rightLabel =
    source.kind === "working" && source.mode === "+"
      ? t("editor.diffStaged")
      : source.kind === "working"
        ? t("editor.diffSideBBadge")
        : t("editor.diffModified");

  const showViewer = state.kind === "loaded" && !useFallback;

  return (
    <div
      className="@container/diff flex h-full min-h-0 flex-col bg-background"
      onClick={handlePaneClick}
    >
      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-b border-border/60 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Badge
            variant="outline"
            className="text-[10px] uppercase tracking-wide"
          >
            {chipLabel ?? mode}
          </Badge>
          {isBinary ? (
            <Badge variant="secondary" className="text-[10px]">
              {t("editor.diffBinaryBadge")}
            </Badge>
          ) : isTooLarge ? (
            <Badge variant="secondary" className="text-[10px]">
              {t("editor.diffLargeBadge")}
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
          <span className="max-w-80 truncate font-mono">{repoRoot}</span>
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

      {showViewer ? (
        <DiffToolbar
          options={options}
          summary={summaryText}
          onChange={patchOptions}
          onPrevious={() => stepDiff(-1)}
          onNext={() => stepDiff(1)}
          onRefresh={loadFresh}
          onJumpToSource={jumpToSource}
          differenceCount={diffCount}
        />
      ) : null}

      {showViewer && diffMode === "split" ? (
        <div className="flex h-6 shrink-0 items-stretch border-b border-border/60 text-[10.5px] text-muted-foreground">
          <span
            className="flex min-w-0 flex-1 items-center gap-2 truncate px-3 font-mono"
            title={leftLabel}
          >
            <span className="truncate">{leftLabel}</span>
            <span className="rounded bg-muted px-1 text-[9px] uppercase tracking-wide">
              {t("editor.diffSideABadge")}
            </span>
          </span>
          <span
            className="flex min-w-0 flex-1 items-center gap-2 truncate border-l border-border/60 px-3 font-mono"
            title={rightLabel}
          >
            <span className="truncate">{rightLabel}</span>
            <span className="rounded bg-muted px-1 text-[9px] uppercase tracking-wide">
              {t("editor.diffSideBBadge")}
            </span>
          </span>
        </div>
      ) : null}
      {showViewer && diffMode === "inline" ? (
        <div className="flex h-6 shrink-0 items-center gap-2 border-b border-border/60 px-3 font-mono text-[10.5px] text-muted-foreground">
          <span className="truncate">
            {leftLabel} → {rightLabel}
          </span>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {showViewer && overview ? (
          <DiffOverview
            totalLines={overview.totalLines}
            marks={overview.marks}
            onJump={jumpToLine}
          />
        ) : null}
        {state.kind === "loading" || state.kind === "idle" ? (
          <div className="flex h-full items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            {t("editor.diffLoading")}
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
          <div ref={mergeRootRef} className="terax-diff-host h-full" />
        ) : (
          <CodeMirror
            ref={cmRef}
            value={modifiedContent}
            theme={themeExt}
            extensions={inlineExtensions}
            editable={false}
            height="100%"
            className="h-full"
            basicSetup={{
              lineNumbers: true,
              foldGutter: false,
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
