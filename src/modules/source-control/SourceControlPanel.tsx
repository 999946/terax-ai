import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { IS_MAC } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { type GitBranchEntry, type GitStashEntry, native } from "@/modules/ai/lib/native";
import {
  copyToClipboard,
  revealInFinder,
} from "@/modules/explorer/lib/contextActions";
import { fileIconUrl, folderIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  COMPACT_CONTENT,
  COMPACT_ITEM,
} from "@/modules/explorer/lib/menuItemClass";
import { joinPath } from "@/modules/explorer/lib/useFileTree";
import {
  AiContentGenerator02Icon,
  Alert02Icon,
  ArchiveIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  CheckmarkCircle01Icon,
  Download01Icon,
  File01Icon,
  FolderCloudIcon,
  FolderGitTwoIcon,
  GitBranchIcon,
  GitMergeIcon,
  MoreHorizontalIcon,
  PlusSignIcon,
  UndoIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { type SourceControlRepositoryTarget } from "./repositoryTarget";
import {
  buildChangeTree,
  directoryPaths,
  flattenChangeTree,
} from "./changeTree";
import type {
  SourceControlRemoteActionMode,
  SourceControlRemoteActionResult,
  SourceControlSummary,
} from "./useSourceControl";
import {
  useSourceControlPanel,
  type CheckState,
  type SourceControlFileEntry,
} from "./useSourceControlPanel";

type Props = {
  open: boolean;
  sourceControl: SourceControlSummary;
  onOpenGitGraph?: () => void;
  onOpenDiff: (input: {
    path: string;
    repoRoot: string;
    mode: "+" | "-";
    originalPath: string | null;
    title?: string;
  }) => void;
  onOpenFile?: (absolutePath: string) => void;
  onNavigateToPath?: (path: string) => void;
  repositoryTarget: SourceControlRepositoryTarget;
  onFollowRepositoryContext: () => void;
  /** Optional multi-repository discovery. When set, renders a repository strip
   * and lets the user focus one repo; the `sourceControl` prop must be the
   * focused repo's summary. */
  repositories?: RepoRow[];
  focusedRoot?: string | null;
  onFocusRepo?: (root: string) => void;
  onRefresh?: () => void;
  /** Total changed files across all repositories (for the global badge). */
  allChangedCount?: number;
};

/** Lightweight per-repo row for the repository strip. */
export type RepoRow = {
  repoRoot: string;
  label: string;
  branch: string | null;
  ahead: number;
  behind: number;
  stagedCount: number;
  unstagedCount: number;
  changedCount: number;
  statusLabel: string | null;
  loading: boolean;
  error: string | null;
  /** Run a remote action (fetch/pull/push) against this repo. */
  runRemoteAction: (
    mode?: SourceControlRemoteActionMode,
  ) => Promise<SourceControlRemoteActionResult>;
  /** Refresh this repo's status (used after branch operations). */
  refresh: () => Promise<void>;
};

const SOURCE_CONTROL_TOOLTIP_CLASS =
  "border border-border/70 bg-zinc-950 text-zinc-100 shadow-lg shadow-black/30 dark:border-border/60 dark:bg-zinc-950 dark:text-zinc-100";

const ROW_HEIGHTS = {
  banner: 32,
  header: 30,
  entry: 30,
} as const;

// Tree indentation: a small base plus one step per nesting depth. The step is
// kept tight so deep folder nesting stays compact while files clearly sit
// under their containing folder.
const TREE_INDENT_BASE = 6;
const TREE_INDENT_STEP = 8;

type RowDescriptor =
  | { kind: "banner-diverged"; key: string }
  | { kind: "list-header"; key: string; count: number }
  | Extract<import("./changeTree").ChangeRow, { kind: "dir" }>
  | Extract<import("./changeTree").ChangeRow, { kind: "file" }>;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "";
  return normalized.slice(0, index);
}

function entryPathLabel(entry: SourceControlFileEntry): string {
  if (entry.originalPath) return `${entry.originalPath} → ${entry.path}`;
  return dirname(entry.path);
}

function upstreamBadgeLabel(
  upstream: string | null | undefined,
  noUpstreamLabel: string,
): string {
  if (!upstream) return noUpstreamLabel;
  return upstream;
}

function statusAccent(code: string): string {
  switch (code) {
    case "A":
      return "bg-emerald-500/85";
    case "U":
      return "bg-teal-500/85";
    case "M":
      return "bg-amber-500/85";
    case "D":
      return "bg-rose-500/85";
    case "R":
      return "bg-sky-500/85";
    default:
      return "bg-muted-foreground/40";
  }
}

function checkboxValue(state: CheckState): boolean | "indeterminate" {
  if (state === "checked") return true;
  if (state === "indeterminate") return "indeterminate";
  return false;
}

export const SourceControlPanel = memo(function SourceControlPanel({
  open,
  sourceControl,
  onOpenGitGraph,
  onOpenDiff,
  onOpenFile,
  repositories = [],
  focusedRoot,
  onFocusRepo,
  onRefresh: refreshRepositories,
}: Props) {
  const { t } = useTranslation();
  const scm = useSourceControlPanel(open, sourceControl, onOpenDiff);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [reposCollapsed, setReposCollapsed] = useState(false);
  const allChangedRepos = useMemo(
    () => repositories.filter((r) => r.changedCount > 0).length,
    [repositories],
  );

  // Fixed repository pinning no longer re-scopes Source Control: the panel
  // always reflects the active Space root, so there is never a pending
  // fixed-target load that could mask a no-repo Space.
  const fixedTargetPending = false;
  const panelState = scm.panelState;
  const repoLabel = useMemo(() => {
    if (!scm.status) return t("sourceControl.branchLabelFallback");
    return scm.status.isDetached
      ? t("sourceControl.detached")
      : scm.status.branch;
  }, [scm.status, t]);

  const commitShortcut = IS_MAC ? "⌘↩" : "Ctrl+Enter";
  const generateShortcut = IS_MAC ? "⌘G" : "Ctrl+G";
  const canCommit =
    scm.stagedEntries.length > 0 &&
    scm.commitMessage.trim().length > 0 &&
    !fixedTargetPending &&
    !scm.actionBusy;
  const commitDisabledReason = scm.actionBusy
    ? t("sourceControl.waitActionFinish")
    : scm.stagedEntries.length === 0
      ? t("sourceControl.stageToCommit")
      : scm.commitMessage.trim().length === 0
        ? t("sourceControl.enterMessageToCommit")
        : null;
  const commitHint = canCommit
    ? t("sourceControl.commitShortcutHint", { shortcut: commitShortcut })
    : (commitDisabledReason ??
       t("sourceControl.commitShortcutHint", { shortcut: commitShortcut }));
  const pushHint =
    scm.pushHint ?? t("sourceControl.pushUnavailable");
  const pushDisabledReason = fixedTargetPending
    ? t("sourceControl.waitRepoLoad")
    : scm.actionBusy
      ? t("sourceControl.waitActionFinish")
      : pushHint;
  const stagedCount = scm.stagedEntries.length;
  const changedCount = scm.fileEntries.length;
  const pushStatusLabel = upstreamBadgeLabel(
    scm.status?.upstream,
    t("sourceControl.noUpstream"),
  );
  const isDiverged =
    !!scm.status && scm.status.ahead > 0 && scm.status.behind > 0;

  const footerFeedback = useMemo(() => {
    if (scm.actionError)
      return { tone: "error", message: scm.actionError } as const;
    if (scm.remoteError)
      return { tone: "error", message: scm.remoteError } as const;
    if (scm.actionMessage)
      return { tone: "success", message: scm.actionMessage } as const;
    return null;
  }, [scm.actionError, scm.actionMessage, scm.remoteError]);

  const handleCommitShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      (event.metaKey || event.ctrlKey) &&
      canCommit
    ) {
      event.preventDefault();
      void scm.commit();
      return;
    }
    if (
      event.key.toLowerCase() === "g" &&
      (event.metaKey || event.ctrlKey) &&
      scm.canGenerateCommitMessage
    ) {
      event.preventDefault();
      void scm.generateCommitMessage();
    }
  };

  const handleRefresh = useCallback(() => {
    void Promise.all([scm.refresh(), refreshRepositories?.()]);
  }, [refreshRepositories, scm]);

  const changeTree = useMemo(
    () => buildChangeTree(scm.fileEntries),
    [scm.fileEntries],
  );

  // Per-folder info for the tree rows: descendant file paths (to batch
  // stage/unstage/discard), the folder's aggregate check state (checked when
  // all its files are staged, indeterminate when some are), and whether any
  // descendant has unstaged changes that can be discarded.
  const dirInfo = useMemo(() => {
    const info = new Map<string, DirInfo>();
    for (const dir of directoryPaths(changeTree)) {
      const prefix = `${dir}/`;
      const files = scm.fileEntries.filter((e) => e.path.startsWith(prefix));
      const allChecked =
        files.length > 0 && files.every((e) => e.checkState === "checked");
      const anyStaged = files.some((e) => e.staged);
      const checkState: CheckState = allChecked
        ? "checked"
        : anyStaged
          ? "indeterminate"
          : "unchecked";
      info.set(dir, {
        paths: files.map((e) => e.path),
        checkState,
        hasUnstaged: files.some((e) => e.unstaged),
      });
    }
    return info;
  }, [changeTree, scm.fileEntries]);

  useEffect(() => {
    const paths = directoryPaths(changeTree);
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      for (const path of paths) next.add(path);
      return next.size === prev.size ? prev : next;
    });
  }, [changeTree]);

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const rows = useMemo<RowDescriptor[]>(() => {
    const result: RowDescriptor[] = [];
    if (isDiverged) result.push({ kind: "banner-diverged", key: "banner-diverged" });
    if (changedCount > 0) {
      result.push({ kind: "list-header", key: "list-header", count: changedCount });
      result.push(...flattenChangeTree(changeTree, expandedDirs));
    }
    return result;
  }, [changedCount, changeTree, expandedDirs, isDiverged]);

  const rowKeyToIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(row.key, index));
    return map;
  }, [rows]);

  useEffect(() => {
    if (!focusedRowKey) return;
    if (!rowKeyToIndex.has(focusedRowKey)) {
      setFocusedRowKey(null);
    }
  }, [focusedRowKey, rowKeyToIndex]);

  const focusableIndices = useMemo(() => {
    const out: number[] = [];
    rows.forEach((row, index) => {
      if ((row.kind === "file" || row.kind === "dir")) out.push(index);
    });
    return out;
  }, [rows]);

  const estimateSize = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return ROW_HEIGHTS.entry;
      switch (row.kind) {
        case "banner-diverged":
          return ROW_HEIGHTS.banner;
        case "list-header":
          return ROW_HEIGHTS.header;
        case "dir":
        case "file":
          return ROW_HEIGHTS.entry;
      }
    },
    [rows],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    overscan: 12,
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  const moveFocus = useCallback(
    (direction: 1 | -1) => {
      if (focusableIndices.length === 0) return;
      const currentIndex =
        focusedRowKey === null ? -1 : (rowKeyToIndex.get(focusedRowKey) ?? -1);
      let pos = focusableIndices.findIndex((i) => i === currentIndex);
      if (pos === -1) pos = direction > 0 ? -1 : focusableIndices.length;
      let nextPos = pos + direction;
      if (nextPos < 0) nextPos = 0;
      if (nextPos > focusableIndices.length - 1)
        nextPos = focusableIndices.length - 1;
      const targetRowIndex = focusableIndices[nextPos];
      const target = rows[targetRowIndex];
      if (!target) return;
      setFocusedRowKey(target.key);
      virtualizer.scrollToIndex(targetRowIndex, { align: "auto" });
    },
    [focusableIndices, focusedRowKey, rowKeyToIndex, rows, virtualizer],
  );

  const focusedEntry = useCallback((): SourceControlFileEntry | null => {
    if (!focusedRowKey) return null;
    const index = rowKeyToIndex.get(focusedRowKey);
    if (index === undefined) return null;
    const row = rows[index];
    return row?.kind === "file" ? row.entry : null;
  }, [focusedRowKey, rowKeyToIndex, rows]);

  const handlePanelKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "TEXTAREA" ||
          target.tagName === "INPUT" ||
          target.closest("button"))
      ) {
        return;
      }
      const meta = event.metaKey || event.ctrlKey;
      if (meta && (event.key === "r" || event.key === "R")) {
        event.preventDefault();
        handleRefresh();
        return;
      }
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveFocus(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          moveFocus(-1);
          break;
        case "Enter": {
          const index = focusedRowKey ? rowKeyToIndex.get(focusedRowKey) : undefined;
          const row = index === undefined ? undefined : rows[index];
          if (row?.kind === "dir") {
            event.preventDefault();
            toggleDir(row.path);
          } else {
            const entry = focusedEntry();
            if (entry) {
              event.preventDefault();
              void scm.selectFile(entry);
            }
          }
          break;
        }
        case "ArrowRight":
        case "ArrowLeft": {
          const index = focusedRowKey ? rowKeyToIndex.get(focusedRowKey) : undefined;
          const row = index === undefined ? undefined : rows[index];
          if (row?.kind !== "dir") break;
          event.preventDefault();
          if (event.key === "ArrowRight" && !row.isExpanded) toggleDir(row.path);
          else if (event.key === "ArrowLeft" && row.isExpanded) toggleDir(row.path);
          break;
        }
        case " ":
        case "s":
        case "S": {
          if (meta) break;
          const entry = focusedEntry();
          if (entry) {
            event.preventDefault();
            void scm.toggleStageFile(entry);
          }
          break;
        }
        case "d":
        case "D": {
          if (meta) break;
          const entry = focusedEntry();
          if (entry && entry.unstaged) {
            event.preventDefault();
            scm.requestDiscardFile(entry);
          }
          break;
        }
      }
    },
    [focusedEntry, focusedRowKey, handleRefresh, moveFocus, rowKeyToIndex, rows, scm, toggleDir],
  );

  if (!open) return null;

  return (
    <TooltipProvider delayDuration={800} skipDelayDuration={300}>
      <aside className="flex h-full min-w-0 flex-col [contain:layout_style]">
        {repositories.length > 0 ? (
          <div className="shrink-0 border-b border-border/40 px-2 py-2">
            <div className="flex items-center gap-1.5 px-1 pb-1.5">
              <button
                type="button"
                aria-label={
                  reposCollapsed
                    ? t("sourceControl.expandRepositories")
                    : t("sourceControl.collapseRepositories")
                }
                onClick={() => setReposCollapsed((v) => !v)}
                className="flex shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <HugeiconsIcon
                  icon={reposCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                  size={12}
                  strokeWidth={2}
                />
              </button>
              <HugeiconsIcon
                icon={FolderGitTwoIcon}
                size={13}
                strokeWidth={1.8}
                className="shrink-0 text-muted-foreground"
              />
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">
                {t("sourceControl.repositoryList")}
              </span>
              {allChangedRepos > 0 ? (
                <span className="ml-1 shrink-0 rounded-full bg-foreground/10 px-1.5 text-[9.5px] font-semibold tabular-nums text-muted-foreground">
                  {repositories.length}
                </span>
              ) : (
                <span className="ml-1 shrink-0 rounded-full border border-border/60 px-1.5 text-[9.5px] font-semibold tabular-nums text-muted-foreground/70">
                  {repositories.length}
                </span>
              )}
            </div>
            {!reposCollapsed ? (
              <div className="flex flex-col gap-0.5">
                {repositories.map((repository) => (
                  <RepoRowItem
                    key={repository.repoRoot}
                    repository={repository}
                    active={repository.repoRoot === focusedRoot}
                    onFocus={() => onFocusRepo?.(repository.repoRoot)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {onOpenGitGraph ? (
          <button
            type="button"
            onClick={() => onOpenGitGraph()}
            className="group flex shrink-0 cursor-pointer items-center gap-2 border-b border-border/40 px-3 py-2 text-left text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground"
          >
            <HugeiconsIcon
              icon={GitBranchIcon}
              size={13}
              strokeWidth={1.85}
              className="shrink-0"
            />
            <span className="flex-1 text-[12px] font-medium">{t("sourceControl.commitGraph")}</span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={12}
              strokeWidth={2}
              className="shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5"
            />
          </button>
        ) : null}

        {panelState === "loading" ? (
          <PanelCenter title={t("sourceControl.loadingRepo")} />
        ) : null}

        {panelState === "no-repo" ? (
          <PanelCenter
            title={t("sourceControl.noRepository")}
            body={t("sourceControl.noRepoBody")}
          />
        ) : null}

        {panelState === "error" ? (
          <PanelCenter
            title={t("sourceControl.error")}
            body={scm.statusError ?? t("sourceControl.unknownError")}
            action={
              <Button size="sm" onClick={() => void scm.refresh()}>
                {t("common.retry")}
              </Button>
            }
          />
        ) : null}

        {panelState === "ready" && scm.status ? (
          <>
            <div className="relative shrink-0 space-y-2 border-b border-border/40 bg-gradient-to-b from-card/65 to-card/30 px-2.5 pb-2.5 pt-2.5">
              <div
                className={cn(
                  "relative rounded-lg border bg-background/95 shadow-sm transition-colors",
                  scm.commitMessage.length > 0
                    ? "border-border/70"
                    : "border-border/45",
                  "focus-within:border-primary/45 focus-within:shadow-md focus-within:shadow-primary/5",
                )}
              >
                <Textarea
                  value={scm.commitMessage}
                  onChange={(event) => scm.setCommitMessage(event.target.value)}
                  onKeyDown={handleCommitShortcut}
                  placeholder={t("sourceControl.commitMessagePlaceholder")}
                  rows={3}
                  className={cn(
                    "min-h-[72px] border-border resize-none rounded-lg bg-transparent px-3 pb-7 pt-2.5 text-[12.5px] leading-snug shadow-none placeholder:text-muted-foreground/65 focus-visible:ring-0 focus:border-0",
                  )}
                />
                <div className="pointer-events-none absolute inset-x-3 bottom-1.5 flex items-center justify-between p-1 gap-2 text-[10px] tabular-nums text-muted-foreground/55">
                  {scm.commitMessage.length > 0 ? (
                    <span>{t("sourceControl.charCount", { count: scm.commitMessage.length })}</span>
                  ) : (
                    <span className="flex gap-2 items-center">
                      {commitShortcut} <p>{t("sourceControl.toCommit")}</p>
                    </span>
                  )}
                </div>
                <div className="absolute right-1 top-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label={`${scm.generateCommitMessageHint} (${generateShortcut})`}
                        disabled={!scm.canGenerateCommitMessage}
                        onClick={() => void scm.generateCommitMessage()}
                        className={cn(
                          "inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/65 transition-colors",
                          "hover:bg-foreground/[0.06] hover:text-foreground",
                          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/65",
                        )}
                      >
                        {scm.actionBusy === "generate-message" ? (
                          <Spinner className="size-3" />
                        ) : (
                          <HugeiconsIcon
                            icon={AiContentGenerator02Icon}
                            size={14}
                            strokeWidth={1.75}
                          />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="left"
                      className={cn(
                        SOURCE_CONTROL_TOOLTIP_CLASS,
                        "text-[10.5px]",
                      )}
                    >
                      {`${scm.generateCommitMessageHint} (${generateShortcut})`}
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>

              <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full transition-colors",
                    canCommit
                      ? "bg-foreground/80"
                      : stagedCount > 0
                        ? "bg-muted-foreground/60"
                        : "bg-muted-foreground/30",
                  )}
                />
                <span className="truncate font-medium text-foreground/85">
                  {stagedCount === 0
                    ? t("sourceControl.nothingStaged")
                    : stagedCount === 1
                      ? t("sourceControl.stagedFileOne", { count: stagedCount })
                      : t("sourceControl.stagedFileMany", { count: stagedCount })}
                </span>
                <span className="ml-auto shrink-0 truncate text-muted-foreground/65">
                  {pushStatusLabel}
                </span>
              </div>

              <div className="grid w-full grid-cols-2 gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="xs"
                      className="h-7 cursor-pointer text-[11.5px] font-semibold tracking-tight shadow-sm disabled:cursor-not-allowed disabled:shadow-none"
                      disabled={!canCommit}
                      onClick={() => void scm.commit()}
                    >
                      {scm.actionBusy === "commit" ? t("sourceControl.committing") : t("sourceControl.commit")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className={cn(
                      SOURCE_CONTROL_TOOLTIP_CLASS,
                      "text-[10.5px]",
                    )}
                  >
                    {commitHint}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="xs"
                      variant="secondary"
                      className="h-7 cursor-pointer text-[11.5px] font-medium disabled:cursor-not-allowed"
                      disabled={
                        !scm.canPush || fixedTargetPending || !!scm.actionBusy
                      }
                      onClick={() => void scm.push()}
                    >
                      {scm.actionBusy === "push" ? t("sourceControl.pushing") : t("sourceControl.push")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="bottom"
                    className={cn(
                      SOURCE_CONTROL_TOOLTIP_CLASS,
                      "max-w-64 text-[10.5px]",
                    )}
                  >
                    {pushDisabledReason}
                  </TooltipContent>
                </Tooltip>
              </div>

              <CommitFeedback feedback={footerFeedback} />
            </div>

            {scm.allClean ? (
              <CleanTreeHint repoLabel={repoLabel} />
            ) : (
              <div
                ref={containerRef}
                tabIndex={0}
                role="listbox"
                aria-label={t("sourceControl.changedFilesAria")}
                aria-activedescendant={
                  focusedRowKey ? `scm-row-${focusedRowKey}` : undefined
                }
                onKeyDown={handlePanelKeyDown}
                className="relative min-h-0 flex-1 outline-none focus-visible:ring-1 focus-visible:ring-primary/30"
              >
                <div
                  ref={scrollRef}
                  className="h-full overflow-y-auto overflow-x-hidden [scrollbar-gutter:stable]"
                >
                  <div
                    style={{
                      height: virtualizer.getTotalSize(),
                      position: "relative",
                      width: "100%",
                    }}
                  >
                    {virtualizer.getVirtualItems().map((virtualRow) => {
                      const row = rows[virtualRow.index];
                      if (!row) return null;
                      return (
                        <div
                          key={virtualRow.key}
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            width: "100%",
                            height: virtualRow.size,
                            transform: `translateY(${virtualRow.start}px)`,
                          }}
                        >
                          <RowRenderer
                            row={row}
                            focused={focusedRowKey === row.key}
                            selectedPath={scm.selected?.path ?? null}
                            actionBusy={scm.actionBusy}
                            headerCheckState={scm.headerCheckState}
                            repoRoot={scm.repo?.repoRoot ?? null}
                            onFocusRow={setFocusedRowKey}
                            onToggleAll={scm.toggleAll}
                            onSelectFile={scm.selectFile}
                            onToggleStageFile={scm.toggleStageFile}
                            onDiscardFile={scm.requestDiscardFile}
                            onOpenFile={onOpenFile}
                            onToggleDir={toggleDir}
                            dirInfo={dirInfo}
                            onToggleStageDir={scm.toggleStageDir}
                            onDiscardDir={scm.requestDiscardDir}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : null}
      </aside>

      <AlertDialog
        open={scm.pendingDiscard !== null}
        onOpenChange={(o) => {
          if (!o) scm.cancelPendingDiscard();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("sourceControl.discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {scm.pendingDiscard?.scope === "all"
                ? t("sourceControl.discardAllBody", { label: scm.pendingDiscard.label })
                : scm.pendingDiscard
                  ? t("sourceControl.discardBody", { label: scm.pendingDiscard.label })
                  : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => scm.cancelPendingDiscard()}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void scm.confirmPendingDiscard()}>
              {t("sourceControl.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
});

function PanelCenter({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-sm font-medium">{title}</div>
      {body ? (
        <div className="max-w-64 text-[11px] leading-relaxed text-muted-foreground">
          {body}
        </div>
      ) : null}
      {action}
    </div>
  );
}

function CleanTreeHint({ repoLabel }: { repoLabel: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-4 text-center">
      <div className="flex size-8 items-center justify-center rounded-full border border-border/55 text-muted-foreground">
        <HugeiconsIcon
          icon={CheckmarkCircle01Icon}
          size={16}
          strokeWidth={1.6}
        />
      </div>
      <div className="text-[12px] font-medium text-foreground">
        {t("sourceControl.workingTreeClean")}
      </div>
      <div className="text-[10.5px] leading-snug text-muted-foreground">
        {t("sourceControl.onBranch", { branch: repoLabel })}
      </div>
    </div>
  );
}

type RowRendererProps = {
  row: RowDescriptor;
  focused: boolean;
  selectedPath: string | null;
  actionBusy: string | null;
  headerCheckState: CheckState;
  repoRoot: string | null;
  onFocusRow: (key: string | null) => void;
  onToggleAll: () => Promise<void> | void;
  onSelectFile: (entry: SourceControlFileEntry) => Promise<void>;
  onToggleStageFile: (entry: SourceControlFileEntry) => Promise<void>;
  onDiscardFile: (entry: SourceControlFileEntry) => void;
  onOpenFile?: (absolutePath: string) => void;
  onToggleDir: (path: string) => void;
  dirInfo: Map<string, DirInfo>;
  onToggleStageDir: (dir: string, paths: string[]) => Promise<void> | void;
  onDiscardDir: (dir: string, paths: string[]) => void;
};

type DirInfo = {
  paths: string[];
  checkState: CheckState;
  hasUnstaged: boolean;
};

const RowRenderer = memo(function RowRenderer(props: RowRendererProps) {
  const { row } = props;
  switch (row.kind) {
    case "banner-diverged":
      return <DivergedBanner />;
    case "list-header":
      return <ListHeader {...props} row={row} />;
    case "dir":
      return <DirRow {...props} row={row} onToggleDir={props.onToggleDir} />;
    case "file":
      return <EntryRow {...props} row={row} />;
  }
});

function DivergedBanner() {
  const { t } = useTranslation();
  return (
    <div className="mx-2 mt-1 flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-foreground/[0.04] px-2 text-[10.5px] leading-none text-muted-foreground">
      <HugeiconsIcon
        icon={Alert02Icon}
        size={11}
        strokeWidth={1.9}
        className="shrink-0"
      />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground/85">
          {t("sourceControl.divergedFromUpstream")}
        </span>
        <span className="ml-1 opacity-75">{t("sourceControl.resolveInTerminal")}</span>
      </span>
    </div>
  );
}

function ListHeader({
  row,
  actionBusy,
  headerCheckState,
  onToggleAll,
}: RowRendererProps & {
  row: Extract<RowDescriptor, { kind: "list-header" }>;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-7 items-center gap-2 px-3">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/85">
        {t("sourceControl.changes")}
      </span>
      <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-border/60 px-1 text-[9.5px] font-semibold tabular-nums text-muted-foreground">
        {row.count}
      </span>
      <label className="ml-auto flex shrink-0 cursor-pointer select-none items-center gap-1.5 text-[10.5px] font-medium text-muted-foreground hover:text-foreground">
        <span>{t("sourceControl.all")}</span>
        <Checkbox
          aria-label={t("sourceControl.stageAllAria")}
          checked={checkboxValue(headerCheckState)}
          disabled={actionBusy !== null}
          onCheckedChange={() => void onToggleAll()}
          className="size-3.5"
        />
      </label>
    </div>
  );
}

function DirRow({
  row,
  focused,
  actionBusy,
  dirInfo,
  onFocusRow,
  onToggleDir,
  onToggleStageDir,
  onDiscardDir,
}: RowRendererProps & { row: Extract<RowDescriptor, { kind: "dir" }> }) {
  const { t } = useTranslation();
  const iconUrl = folderIconUrl(row.name, row.isExpanded);
  const info = dirInfo.get(row.path);
  const checkState = info?.checkState ?? "unchecked";
  const hasUnstaged = info?.hasUnstaged ?? false;
  const paths = info?.paths ?? [];
  const disabled = actionBusy !== null;
  const isDirBusy =
    actionBusy === `stage:dir:${row.path}` ||
    actionBusy === `unstage:dir:${row.path}`;
  const isDiscardBusy = actionBusy === `discard:dir:${row.path}`;
  return (
    <div
      id={`scm-row-${row.key}`}
      role="option"
      aria-selected={false}
      data-focused={focused || undefined}
      onMouseDown={() => onFocusRow(row.key)}
      className={cn(
        "flex h-[30px] w-full items-center gap-2 rounded-md pr-2 text-left transition-colors",
        focused ? "bg-accent/60" : "hover:bg-accent/30",
      )}
      style={{ paddingLeft: TREE_INDENT_BASE + row.depth * TREE_INDENT_STEP }}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {isDirBusy ? (
          <Spinner className="size-3" />
        ) : (
          <Checkbox
            aria-label={t("sourceControl.stagePathAria", { path: row.path })}
            checked={checkboxValue(checkState)}
            disabled={disabled}
            onCheckedChange={() => void onToggleStageDir(row.path, paths)}
            className="size-3.5"
          />
        )}
      </span>
      <button
        type="button"
        onClick={() => onToggleDir(row.path)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={12}
            strokeWidth={2.25}
            className={cn("transition-transform", row.isExpanded && "rotate-90")}
          />
        </span>
        {iconUrl ? <img src={iconUrl} alt="" className="size-4 shrink-0" /> : <span className="size-4 shrink-0" />}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/95">
          {row.name}
        </span>
      </button>
      {hasUnstaged ? (
        <div className="flex shrink-0 items-center">
          <IconActionButton
            label={t("sourceControl.discardPath", { path: row.path })}
            disabled={disabled}
            side="top"
            onClick={() => onDiscardDir(row.path, paths)}
          >
            {isDiscardBusy ? (
              <Spinner className="size-3" />
            ) : (
              <HugeiconsIcon icon={UndoIcon} size={11} strokeWidth={1.9} />
            )}
          </IconActionButton>
        </div>
      ) : null}
    </div>
  );
}

const EntryRow = memo(function EntryRow({
  row,
  focused,
  selectedPath,
  actionBusy,
  repoRoot,
  onFocusRow,
  onSelectFile,
  onToggleStageFile,
  onDiscardFile,
  onOpenFile,
}: RowRendererProps & {
  row: Extract<RowDescriptor, { kind: "file" }>;
}) {
  const { t } = useTranslation();
  const entry = row.entry;
  const isSelected = selectedPath === entry.path;
  const fileName = basename(entry.path);
  const iconUrl = fileIconUrl(fileName);
  const pathLabel = entryPathLabel(entry);
  const showDiscard = entry.unstaged;
  const isStageBusy =
    actionBusy === `stage:${entry.path}` ||
    actionBusy === `unstage:${entry.path}`;
  const isDiscardBusy = actionBusy === `discard:${entry.path}`;
  const disabled = actionBusy !== null;

  const absolutePath = repoRoot
    ? joinPath(repoRoot.replace(/\\/g, "/"), entry.path.replace(/\\/g, "/"))
    : null;
  const isDeleted = entry.statusCode === "D";
  const revealLabel = IS_MAC
    ? t("sourceControl.revealInFinder")
    : t("sourceControl.revealInFileManager");

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          id={`scm-row-${row.key}`}
          data-focused={focused || undefined}
          data-selected={isSelected || undefined}
          role="option"
          aria-selected={isSelected}
          onMouseDown={() => onFocusRow(row.key)}
          className={cn(
            "group relative flex h-[30px] items-center gap-2 rounded-md pr-2 transition-all duration-100",
            focused
              ? "bg-accent/60"
              : isSelected
                ? "bg-accent/55 text-foreground"
                : "hover:bg-accent/30",
          )}
          style={{ paddingLeft: TREE_INDENT_BASE + row.depth * TREE_INDENT_STEP }}
        >
          <span
            className={cn(
              "pointer-events-none absolute inset-y-1 left-0 w-[2px] rounded-full transition-opacity",
              statusAccent(entry.statusCode),
              isSelected || focused
                ? "opacity-100"
                : "opacity-55 group-hover:opacity-95",
            )}
            aria-hidden
          />
          <span className="flex size-5 shrink-0 items-center justify-center">
            {isStageBusy ? (
              <Spinner className="size-3" />
            ) : (
              <Checkbox
                aria-label={t("sourceControl.stagePathAria", { path: entry.path })}
                checked={checkboxValue(entry.checkState)}
                disabled={disabled}
                onCheckedChange={() => void onToggleStageFile(entry)}
                className="size-3.5"
              />
            )}
          </span>
          <button
            type="button"
            onClick={() => {
              onFocusRow(row.key);
              void onSelectFile(entry);
            }}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          >
            {iconUrl ? (
              <img src={iconUrl} alt="" className="size-4 shrink-0" />
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <div className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-none">
              <span
                className={cn(
                  "truncate text-[12px] leading-tight",
                  isSelected || focused
                    ? "font-semibold text-foreground"
                    : "font-medium text-foreground/95",
                  pathLabel ? "max-w-[58%] shrink-0" : "min-w-0 flex-1",
                )}
              >
                {fileName}
              </span>
              {pathLabel ? (
                <span className="min-w-0 flex-1 truncate text-[10.5px] leading-tight text-muted-foreground/75">
                  {pathLabel}
                </span>
              ) : null}
            </div>
          </button>

          <div className="flex shrink-0 items-center">
            {!isDeleted && onOpenFile && absolutePath ? (
              <IconActionButton
                label={t("sourceControl.openFile")}
                disabled={disabled}
                side="top"
                onClick={() => onOpenFile(absolutePath)}
              >
                <HugeiconsIcon icon={File01Icon} size={11} strokeWidth={1.9} />
              </IconActionButton>
            ) : null}
            {showDiscard ? (
              <IconActionButton
                label={t("sourceControl.discardPath", { path: entry.path })}
                disabled={disabled}
                side="top"
                onClick={() => onDiscardFile(entry)}
              >
                {isDiscardBusy ? (
                  <Spinner className="size-3" />
                ) : (
                  <HugeiconsIcon
                    icon={UndoIcon}
                    size={11}
                    strokeWidth={1.9}
                  />
                )}
              </IconActionButton>
            ) : null}
          </div>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className={COMPACT_CONTENT}>
        {/* Open actions */}
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => {
            onFocusRow(row.key);
            void onSelectFile(entry);
          }}
        >
          {t("sourceControl.openDiff")}
        </ContextMenuItem>
        {!isDeleted && onOpenFile && absolutePath ? (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => onOpenFile(absolutePath)}
          >
            {t("sourceControl.openFile")}
          </ContextMenuItem>
        ) : null}

        <ContextMenuSeparator />

        {/* Stage / Unstage */}
        <ContextMenuItem
          className={COMPACT_ITEM}
          disabled={disabled}
          onSelect={() => void onToggleStageFile(entry)}
        >
          {entry.checkState === "checked"
            ? t("sourceControl.unstage")
            : t("sourceControl.stage")}
        </ContextMenuItem>
        {entry.unstaged ? (
          <ContextMenuItem
            className={COMPACT_ITEM}
            variant="destructive"
            disabled={disabled}
            onSelect={() => onDiscardFile(entry)}
          >
            {t("sourceControl.discardChanges")}
          </ContextMenuItem>
        ) : null}

        <ContextMenuSeparator />

        {/* Copy paths */}
        <ContextMenuItem
          className={COMPACT_ITEM}
          onSelect={() => void copyToClipboard(entry.path.replace(/\\/g, "/"))}
        >
          {t("sourceControl.copyRelativePath")}
        </ContextMenuItem>
        {absolutePath ? (
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => void copyToClipboard(absolutePath)}
          >
            {t("sourceControl.copyAbsolutePath")}
          </ContextMenuItem>
        ) : null}

        {/* Reveal in Finder — only for existing files */}
        {!isDeleted && absolutePath ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className={COMPACT_ITEM}
              onSelect={() => void revealInFinder(absolutePath)}
            >
              {revealLabel}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
});

function RepoRowItem({
  repository,
  active,
  onFocus,
}: {
  repository: RepoRow;
  active: boolean;
  onFocus: () => void;
}) {
  const { t } = useTranslation();
  const normalizedRoot = repository.repoRoot.replace(/\\/g, "/");
  const [menuOpen, setMenuOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchEntry[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [stashMessageOpen, setStashMessageOpen] = useState(false);
  const [stashMessage, setStashMessage] = useState("");
  const [stashIncludeUntracked, setStashIncludeUntracked] = useState(false);
  const [stashDropTarget, setStashDropTarget] = useState<string | null>(null);
  const [pushAfterCreate, setPushAfterCreate] = useState(false);
  const loadRef = useRef(0);

  const loadBranches = useCallback(async () => {
    const id = ++loadRef.current;
    setLoadingBranches(true);
    setBranchError(null);
    try {
      const result = await native.gitListBranches(repository.repoRoot);
      if (id !== loadRef.current) return;
      setBranches(result.branches);
    } catch (e) {
      if (id !== loadRef.current) return;
      setBranches([]);
      setBranchError(String(e));
    } finally {
      if (id === loadRef.current) setLoadingBranches(false);
    }
  }, [repository.repoRoot]);

  const loadStashes = useCallback(async () => {
    try {
      const result = await native.gitStashList(repository.repoRoot);
      setStashes(result.stashes);
    } catch (e) {
      toast.error(String(e));
    }
  }, [repository.repoRoot]);

  useEffect(() => {
    if (menuOpen) {
      void loadBranches();
      void loadStashes();
    }
  }, [menuOpen, loadBranches, loadStashes]);

  const localBranches = useMemo(
    () => branches.filter((b) => b.kind === "local"),
    [branches],
  );
  const remoteBranches = useMemo(
    () => branches.filter((b) => b.kind === "remote"),
    [branches],
  );
  const hasBranches = localBranches.length > 0 || remoteBranches.length > 0;

  const handleCheckout = useCallback(
    async (branch: string) => {
      setBusy("checkout");
      try {
        await native.gitCheckoutBranch(repository.repoRoot, branch);
        await repository.refresh();
      } catch (e) {
        toast.error(String(e));
      } finally {
        setBusy(null);
      }
    },
    [repository],
  );

  const handleCreateBranch = useCallback(async () => {
    const name = newBranchName.trim();
    if (!name) return;
    setBusy("create");
    try {
      await native.gitCreateBranch(repository.repoRoot, name);
      if (pushAfterCreate) {
        await native.gitPushBranch(repository.repoRoot, name);
      }
      await repository.refresh();
      setCreateOpen(false);
      setNewBranchName("");
      setPushAfterCreate(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  }, [newBranchName, pushAfterCreate, repository]);

  const handleStashCreate = useCallback(async () => {
    setBusy("stash-create");
    try {
      await native.gitStashPush(
        repository.repoRoot,
        stashMessage.trim(),
        stashIncludeUntracked,
      );
      await repository.refresh();
      setStashMessageOpen(false);
      setStashMessage("");
      setStashIncludeUntracked(false);
      toast.success(t("sourceControl.stashCreated"));
      void loadStashes();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  }, [stashMessage, stashIncludeUntracked, repository, t, loadStashes]);

  const handleStashApply = useCallback(
    async (index: string) => {
      setBusy("stash-apply");
      try {
        await native.gitStashApply(repository.repoRoot, index);
        await repository.refresh();
        toast.success(t("sourceControl.stashApplied"));
      } catch (e) {
        toast.error(String(e));
      } finally {
        setBusy(null);
      }
    },
    [repository, t],
  );

  const handleStashPop = useCallback(
    async (index: string) => {
      setBusy("stash-pop");
      try {
        await native.gitStashPop(repository.repoRoot, index);
        await repository.refresh();
        toast.success(t("sourceControl.stashPopped"));
        void loadStashes();
      } catch (e) {
        toast.error(String(e));
      } finally {
        setBusy(null);
      }
    },
    [repository, t, loadStashes],
  );

  const handleStashDrop = useCallback(async () => {
    if (!stashDropTarget) return;
    setBusy("stash-drop");
    try {
      await native.gitStashDrop(repository.repoRoot, stashDropTarget);
      await repository.refresh();
      setStashDropTarget(null);
      toast.success(t("sourceControl.stashDropped"));
      void loadStashes();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  }, [stashDropTarget, repository, t, loadStashes]);

  const handleMerge = useCallback(
    async (branch: string) => {
      setBusy("merge");
      try {
        await native.gitMergeBranch(repository.repoRoot, branch);
        await repository.refresh();
      } catch (e) {
        toast.error(String(e));
      } finally {
        setBusy(null);
      }
    },
    [repository],
  );

  const handleUpdateBranch = useCallback(
    async (branch: string) => {
      setBusy("update");
      try {
        await native.gitUpdateBranch(repository.repoRoot, branch);
        await repository.refresh();
      } catch (e) {
        toast.error(String(e));
      } finally {
        setBusy(null);
      }
    },
    [repository],
  );

  const handlePushBranch = useCallback(
    async (branch: string) => {
      setBusy("push");
      try {
        await native.gitPushBranch(repository.repoRoot, branch);
        await repository.refresh();
      } catch (e) {
        toast.error(String(e));
      } finally {
        setBusy(null);
      }
    },
    [repository],
  );

  const handleDeleteBranch = useCallback(async () => {
    const branch = deleteTarget;
    if (!branch) return;
    setBusy("delete");
    try {
      await native.gitDeleteBranch(repository.repoRoot, branch);
      await repository.refresh();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
      setDeleteTarget(null);
    }
  }, [deleteTarget, repository]);

  const handleRemote = useCallback(
    async (mode: SourceControlRemoteActionMode) => {
      const result = await repository.runRemoteAction(mode);
      if (result.ok) return;
      if (result.blocked === "missing-upstream") {
        toast.info(t("sourceControl.noUpstreamCfg"));
      } else if (result.blocked === "diverged") {
        toast.info(t("sourceControl.branchDiverged"));
      } else if (result.error) {
        toast.error(result.error);
      }
    },
    [repository, t],
  );

  const branchBusy = busy !== null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onFocus}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onFocus();
        }
      }}
      className={cn(
        "group relative flex h-[30px] min-w-0 items-center gap-1.5 rounded-md px-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
        active ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <HugeiconsIcon
        icon={FolderGitTwoIcon}
        size={12}
        strokeWidth={1.8}
        className={cn(
          "shrink-0",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      />
      <span
        className={cn(
          "min-w-0 max-w-[46%] shrink-0 truncate text-[11.5px] font-medium leading-tight",
          active ? "text-foreground" : "text-foreground/90",
        )}
      >
        {repository.label}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1 text-[10px] leading-tight text-muted-foreground">
        <HugeiconsIcon icon={GitBranchIcon} size={9} strokeWidth={2} className="shrink-0" />
        <span className="min-w-0 truncate">{repository.branch ?? "—"}</span>
        {repository.ahead > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-0.5">
            <HugeiconsIcon icon={ArrowUp01Icon} size={9} strokeWidth={2.2} />
            {repository.ahead}
          </span>
        ) : null}
        {repository.behind > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-0.5">
            <HugeiconsIcon icon={ArrowDown01Icon} size={9} strokeWidth={2.2} />
            {repository.behind}
          </span>
        ) : null}
      </span>

      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
        {repository.changedCount > 0 ? repository.changedCount : ""}
      </span>

      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <IconActionButton
          label={t("sourceControl.fetch")}
          side="top"
          onClick={(e) => {
            e.stopPropagation();
            void handleRemote("fetch");
          }}
        >
          {repository.loading ? (
            <Spinner className="size-3" />
          ) : (
            <HugeiconsIcon icon={FolderCloudIcon} size={11} strokeWidth={1.9} />
          )}
        </IconActionButton>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("common.moreActions")}
              onClick={(e) => e.stopPropagation()}
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} size={13} strokeWidth={1.8} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className={COMPACT_CONTENT}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            {/* Switch branch */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={COMPACT_ITEM}>
                <HugeiconsIcon icon={GitBranchIcon} size={13} strokeWidth={1.8} />
                <span className="flex-1">{t("sourceControl.switchBranch")}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={COMPACT_CONTENT}>
                {loadingBranches ? (
                  <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
                    <Spinner className="size-3" />
                    {t("sourceControl.loadingBranches")}
                  </div>
                ) : branchError ? (
                  <div className="px-3 py-2 text-[11px] leading-snug text-destructive">
                    {branchError}
                  </div>
                ) : hasBranches ? (
                  <>
                    {localBranches.length > 0 && (
                      <>
                        <div className="px-3 pb-0.5 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                          {t("sourceControl.localBranches")}
                        </div>
                        {localBranches.map((b) => (
                          <DropdownMenuSub key={b.name}>
                            <DropdownMenuSubTrigger
                              className={cn(COMPACT_ITEM, "flex items-center gap-2")}
                            >
                              {b.isHead ? (
                                <HugeiconsIcon
                                  icon={Tick02Icon}
                                  size={13}
                                  strokeWidth={2}
                                  className="shrink-0 text-foreground"
                                />
                              ) : (
                                <span className="w-3.5 shrink-0" />
                              )}
                              <span className="min-w-0 flex-1 truncate">{b.name}</span>
                              {b.ahead > 0 || b.behind > 0 ? (
                                <span className="flex shrink-0 items-center gap-1 pl-1 text-[10px] font-medium tabular-nums text-muted-foreground/70">
                                  {b.ahead > 0 ? (
                                    <span className="flex items-center gap-0.5">
                                      <HugeiconsIcon
                                        icon={ArrowUp01Icon}
                                        size={10}
                                        strokeWidth={2}
                                      />
                                      {b.ahead}
                                    </span>
                                  ) : null}
                                  {b.behind > 0 ? (
                                    <span className="flex items-center gap-0.5">
                                      <HugeiconsIcon
                                        icon={ArrowDown01Icon}
                                        size={10}
                                        strokeWidth={2}
                                      />
                                      {b.behind}
                                    </span>
                                  ) : null}
                                </span>
                              ) : null}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className={COMPACT_CONTENT}>
                              <DropdownMenuItem
                                className={COMPACT_ITEM}
                                disabled={branchBusy}
                                onSelect={() => void handleCheckout(b.name)}
                              >
                                <HugeiconsIcon icon={GitBranchIcon} size={13} strokeWidth={1.8} />
                                <span className="flex-1">{t("sourceControl.switchBranch")}</span>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className={COMPACT_ITEM}
                                disabled={branchBusy || b.isHead}
                                onSelect={() => void handleMerge(b.name)}
                              >
                                <HugeiconsIcon icon={GitMergeIcon} size={13} strokeWidth={1.8} />
                                <span className="flex-1">{t("sourceControl.mergeBranch")}</span>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className={COMPACT_ITEM}
                                disabled={branchBusy}
                                onSelect={() => void handleUpdateBranch(b.name)}
                              >
                                <HugeiconsIcon icon={Download01Icon} size={13} strokeWidth={1.8} />
                                <span className="flex-1">{t("sourceControl.updateBranch")}</span>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className={COMPACT_ITEM}
                                disabled={branchBusy}
                                onSelect={() => void handlePushBranch(b.name)}
                              >
                                <HugeiconsIcon icon={ArrowUp01Icon} size={13} strokeWidth={1.8} />
                                <span className="flex-1">{t("sourceControl.push")}</span>
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className={COMPACT_ITEM}
                                disabled={branchBusy || b.isHead}
                                onSelect={() => setDeleteTarget(b.name)}
                              >
                                <HugeiconsIcon icon={UndoIcon} size={13} strokeWidth={1.8} />
                                <span className="flex-1 text-destructive">
                                  {t("sourceControl.deleteBranch")}
                                </span>
                              </DropdownMenuItem>
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        ))}
                      </>
                    )}
                    {localBranches.length > 0 && remoteBranches.length > 0 && (
                      <DropdownMenuSeparator />
                    )}
                    {remoteBranches.length > 0 && (
                      <>
                        <div className="px-3 pb-0.5 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                          {t("sourceControl.remoteBranches")}
                        </div>
                        {remoteBranches.map((b) => (
                          <DropdownMenuSub key={b.name}>
                            <DropdownMenuSubTrigger
                              className={cn(COMPACT_ITEM, "flex items-center gap-2")}
                            >
                              <span className="w-3.5 shrink-0" />
                              <span className="min-w-0 flex-1 truncate">{b.name}</span>
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className={COMPACT_CONTENT}>
                              <DropdownMenuItem
                                className={COMPACT_ITEM}
                                disabled={branchBusy}
                                onSelect={() => void handleCheckout(b.name)}
                              >
                                <HugeiconsIcon icon={GitBranchIcon} size={13} strokeWidth={1.8} />
                                <span className="flex-1">{t("sourceControl.switchBranch")}</span>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className={COMPACT_ITEM}
                                disabled={branchBusy}
                                onSelect={() => void handleMerge(b.name)}
                              >
                                <HugeiconsIcon icon={GitMergeIcon} size={13} strokeWidth={1.8} />
                                <span className="flex-1">{t("sourceControl.mergeBranch")}</span>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className={COMPACT_ITEM}
                                disabled={branchBusy}
                                onSelect={() => void handleUpdateBranch(b.name)}
                              >
                                <HugeiconsIcon icon={Download01Icon} size={13} strokeWidth={1.8} />
                                <span className="flex-1">{t("sourceControl.updateBranch")}</span>
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className={COMPACT_ITEM}
                                disabled
                              >
                                <HugeiconsIcon icon={ArrowUp01Icon} size={13} strokeWidth={1.8} />
                                <span className="flex-1">{t("sourceControl.push")}</span>
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className={COMPACT_ITEM}
                                disabled={branchBusy}
                                onSelect={() => setDeleteTarget(b.name)}
                              >
                                <HugeiconsIcon icon={UndoIcon} size={13} strokeWidth={1.8} />
                                <span className="flex-1 text-destructive">
                                  {t("sourceControl.deleteBranch")}
                                </span>
                              </DropdownMenuItem>
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        ))}
                      </>
                    )}
                  </>
                ) : (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    {t("sourceControl.noBranchesFound")}
                  </div>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Create branch */}
            <DropdownMenuItem
              className={COMPACT_ITEM}
              disabled={branchBusy}
              onSelect={() => setCreateOpen(true)}
            >
              <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={1.8} />
              <span className="flex-1">{t("sourceControl.createBranch")}</span>
            </DropdownMenuItem>

            {/* Stash */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={COMPACT_ITEM}>
                <HugeiconsIcon icon={ArchiveIcon} size={13} strokeWidth={1.8} />
                <span className="flex-1">{t("sourceControl.stash")}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={COMPACT_CONTENT}>
                <DropdownMenuItem
                  className={COMPACT_ITEM}
                  disabled={branchBusy}
                  onSelect={() => setStashMessageOpen(true)}
                >
                  <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={1.8} />
                  <span className="flex-1">{t("sourceControl.newStash")}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {stashes.length === 0 ? (
                  <DropdownMenuItem
                    className={cn(COMPACT_ITEM, "opacity-60")}
                    disabled
                  >
                    <span className="flex-1">{t("sourceControl.noStashes")}</span>
                  </DropdownMenuItem>
                ) : (
                  stashes.map((s) => (
                    <DropdownMenuSub key={s.index}>
                      <DropdownMenuSubTrigger className={COMPACT_ITEM}>
                        <span className="min-w-0 flex-1 truncate">
                          {s.message || s.index}
                        </span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className={COMPACT_CONTENT}>
                        <DropdownMenuItem
                          className={COMPACT_ITEM}
                          disabled={branchBusy}
                          onSelect={() => void handleStashApply(s.index)}
                        >
                          <HugeiconsIcon icon={Download01Icon} size={13} strokeWidth={1.8} />
                          <span className="flex-1">{t("sourceControl.applyStash")}</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className={COMPACT_ITEM}
                          disabled={branchBusy}
                          onSelect={() => void handleStashPop(s.index)}
                        >
                          <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={1.8} />
                          <span className="flex-1">{t("sourceControl.popStash")}</span>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className={COMPACT_ITEM}
                          disabled={branchBusy}
                          onSelect={() => setStashDropTarget(s.index)}
                        >
                          <HugeiconsIcon icon={UndoIcon} size={13} strokeWidth={1.8} />
                          <span className="flex-1 text-destructive">
                            {t("sourceControl.dropStash")}
                          </span>
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Merge branch */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={COMPACT_ITEM}>
                <HugeiconsIcon icon={GitMergeIcon} size={13} strokeWidth={1.8} />
                <span className="flex-1">{t("sourceControl.mergeBranch")}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={COMPACT_CONTENT}>
                {loadingBranches ? (
                  <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-muted-foreground">
                    <Spinner className="size-3" />
                    {t("sourceControl.loadingBranches")}
                  </div>
                ) : branchError ? (
                  <div className="px-3 py-2 text-[11px] leading-snug text-destructive">
                    {branchError}
                  </div>
                ) : hasBranches ? (
                  <>
                    {localBranches.length > 1 && (
                      <>
                        <div className="px-3 pb-0.5 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                          {t("sourceControl.localBranches")}
                        </div>
                        {localBranches
                          .filter((b) => !b.isHead)
                          .map((b) => (
                            <DropdownMenuItem
                              key={b.name}
                              disabled={branchBusy}
                              onSelect={() => void handleMerge(b.name)}
                              className={cn(COMPACT_ITEM, "flex items-center gap-2")}
                            >
                              <span className="min-w-0 flex-1 truncate">{b.name}</span>
                            </DropdownMenuItem>
                          ))}
                      </>
                    )}
                    {localBranches.length > 1 && remoteBranches.length > 0 && (
                      <DropdownMenuSeparator />
                    )}
                    {remoteBranches.length > 0 && (
                      <>
                        <div className="px-3 pb-0.5 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                          {t("sourceControl.remoteBranches")}
                        </div>
                        {remoteBranches.map((b) => (
                          <DropdownMenuItem
                            key={b.name}
                            disabled={branchBusy}
                            onSelect={() => void handleMerge(b.name)}
                            className={cn(COMPACT_ITEM, "flex items-center gap-2")}
                          >
                            <span className="min-w-0 flex-1 truncate">{b.name}</span>
                          </DropdownMenuItem>
                        ))}
                      </>
                    )}
                  </>
                ) : (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    {t("sourceControl.noBranchesFound")}
                  </div>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            {/* Remote actions */}
            <DropdownMenuItem
              className={COMPACT_ITEM}
              disabled={busy === "fetch"}
              onSelect={() => void handleRemote("fetch")}
            >
              <HugeiconsIcon icon={FolderCloudIcon} size={13} strokeWidth={1.8} />
              <span className="flex-1">{t("sourceControl.fetch")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={COMPACT_ITEM}
              disabled={busy === "pull"}
              onSelect={() => void handleRemote("pull")}
            >
              <HugeiconsIcon icon={Download01Icon} size={13} strokeWidth={1.8} />
              <span className="flex-1">{t("sourceControl.pull")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={COMPACT_ITEM}
              disabled={busy === "push"}
              onSelect={() => void handleRemote("push")}
            >
              <HugeiconsIcon icon={ArrowUp01Icon} size={13} strokeWidth={1.8} />
              <span className="flex-1">{t("sourceControl.push")}</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* Copy / reveal */}
            <DropdownMenuItem
              className={COMPACT_ITEM}
              onSelect={() => void copyToClipboard(normalizedRoot)}
            >
              <span className="flex-1">{t("sourceControl.copyRepoPath")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={COMPACT_ITEM}
              onSelect={() => void revealInFinder(normalizedRoot)}
            >
              <span className="flex-1">{t("sourceControl.revealInFinder")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={createOpen} onOpenChange={setCreateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("sourceControl.createBranchTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("sourceControl.createBranchBody", {
                branch: repository.branch ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-1">
            <Input
              autoFocus
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newBranchName.trim()) {
                  e.preventDefault();
                  void handleCreateBranch();
                }
              }}
              placeholder={t("sourceControl.createBranchPlaceholder")}
              className="h-8 text-[12.5px]"
            />
            <label className="mt-2 flex cursor-pointer select-none items-center gap-2 px-0.5 text-[12px] text-muted-foreground">
              <Checkbox
                checked={pushAfterCreate}
                onCheckedChange={(c) => setPushAfterCreate(c === true)}
                className="size-3.5"
              />
              {t("sourceControl.pushAfterCreate")}
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setCreateOpen(false)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!newBranchName.trim() || busy === "create"}
              onClick={() => void handleCreateBranch()}
            >
              {busy === "create" ? t("sourceControl.creating") : t("sourceControl.createBranch")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("sourceControl.deleteBranchConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget
                ? t("sourceControl.deleteBranchConfirmBody", { branch: deleteTarget })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "delete"}
              onClick={() => void handleDeleteBranch()}
            >
              {busy === "delete"
                ? t("sourceControl.deleting")
                : t("sourceControl.deleteBranch")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={stashMessageOpen}
        onOpenChange={(o) => {
          if (!o) {
            setStashMessageOpen(false);
            setStashMessage("");
            setStashIncludeUntracked(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("sourceControl.newStash")}</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="px-1">
            <Input
              autoFocus
              value={stashMessage}
              onChange={(e) => setStashMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleStashCreate();
                }
              }}
              placeholder={t("sourceControl.stashMessagePlaceholder")}
              className="h-8 text-[12.5px]"
            />
            <label className="mt-2 flex cursor-pointer select-none items-center gap-2 px-0.5 text-[12px] text-muted-foreground">
              <Checkbox
                checked={stashIncludeUntracked}
                onCheckedChange={(c) => setStashIncludeUntracked(c === true)}
                className="size-3.5"
              />
              {t("sourceControl.stashIncludeUntracked")}
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setStashMessageOpen(false)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "stash-create"}
              onClick={() => void handleStashCreate()}
            >
              {busy === "stash-create"
                ? t("sourceControl.stashing")
                : t("sourceControl.stash")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={stashDropTarget !== null}
        onOpenChange={(o) => {
          if (!o) setStashDropTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("sourceControl.dropStashConfirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {stashDropTarget
                ? t("sourceControl.dropStashConfirmBody", {
                    stash: stashDropTarget,
                  })
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setStashDropTarget(null)}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy === "stash-drop"}
              onClick={() => void handleStashDrop()}
            >
              {busy === "stash-drop"
                ? t("sourceControl.droppingStash")
                : t("sourceControl.dropStash")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function IconActionButton({
  label,
  disabled,
  side = "left",
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  side?: "left" | "top" | "right" | "bottom";
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          className="size-6 p-3 cursor-pointer rounded-md text-muted-foreground hover:text-foreground disabled:cursor-not-allowed"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side={side}
        className={cn(SOURCE_CONTROL_TOOLTIP_CLASS, "text-[10.5px]")}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function CommitFeedback({
  feedback,
}: {
  feedback: { tone: "error" | "success"; message: string } | null;
}) {
  const [visibleFeedback, setVisibleFeedback] = useState(feedback);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!feedback) {
      setIsVisible(false);
      return;
    }
    setVisibleFeedback(feedback);
    setIsVisible(true);
    const hideTimer = window.setTimeout(() => setIsVisible(false), 3600);
    const clearTimer = window.setTimeout(() => {
      setVisibleFeedback((current) =>
        current?.message === feedback.message && current.tone === feedback.tone
          ? null
          : current,
      );
    }, 3900);
    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(clearTimer);
    };
  }, [feedback]);

  if (!visibleFeedback) return null;

  const isError = visibleFeedback.tone === "error";
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-3 top-[calc(100%-0.25rem)] z-20 flex min-w-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] leading-snug shadow-lg shadow-black/15 backdrop-blur transition-all duration-200",
        isVisible ? "translate-y-0 opacity-100" : "-translate-y-1 opacity-0",
        isError
          ? "border-destructive/30 bg-card/95 text-destructive"
          : "border-border/70 bg-card/95 text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isError ? "bg-destructive" : "bg-foreground/70",
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          isError ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {visibleFeedback.message}
      </span>
    </div>
  );
}
