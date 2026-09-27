import {
  Alert02Icon,
  CheckmarkCircle01Icon,
  GitMergeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  native,
  type GitMergeStatusResult,
} from "@/modules/ai/lib/native";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getMergeStatus } from "./mergeStatusCache";

const MERGE_TOOLTIP_CLASS =
  "border border-border/70 bg-zinc-950 text-zinc-100 shadow-lg shadow-black/30 dark:border-border/60 dark:bg-zinc-950 dark:text-zinc-100";

/**
 * Per-repo merge status against the configured target branches. Renders one
 * icon per target: a gray ✅ when merged, a clickable merge icon when not
 * (keeps the one-click merge-into flow), an alert on error, and a spinner
 * while a merge is running. Hover shows the target branch name. Hidden when no
 * targets are configured or the repo can't be resolved.
 *
 * `onMergeDone` fires after a merge-into attempt (success or failure) so a
 * caller can refresh its own row/branch data.
 */
export function useRepoMergeStatus(
  repoRoot: string | null,
  branch: string | null,
  onMergeDone?: () => void,
) {
  const { t } = useTranslation();
  const targets = usePreferencesStore((s) => s.gitTargetBranches ?? []);
  const [status, setStatus] = useState<GitMergeStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(
    (force: boolean) => {
      if (!repoRoot || targets.length === 0) {
        setStatus(null);
        return;
      }
      setLoading(true);
      void getMergeStatus(repoRoot, targets, { force }).then((res) => {
        setStatus(res);
        setLoading(false);
      });
    },
    [repoRoot, targets],
  );

  useEffect(() => {
    refresh(false);
  }, [refresh]);

  const mergeInto = useCallback(
    async (target: string) => {
      if (!repoRoot || busy) return;
      setBusy(target);
      try {
        await native.gitMergeIntoBranch(repoRoot, target);
        toast.success(
          t("sourceControl.mergedIntoTarget", {
            branch: status?.branch ?? branch ?? "",
            target,
          }),
        );
      } catch (e) {
        toast.error(String(e));
      } finally {
        // Refresh regardless (success or failure) so the icon reflects the real
        // state, then let the caller refresh its own row.
        refresh(true);
        onMergeDone?.();
        setBusy(null);
      }
    },
    [busy, repoRoot, branch, status, t, refresh, onMergeDone],
  );

  return { targets, status, loading, busy, refresh, mergeInto };
}

/**
 * Renders the per-repo merge-status icon group for the given repo.
 * `className` is applied to the wrapping flex span.
 */
export function MergeStatusIcons({
  repoRoot,
  branch,
  onMergeDone,
  className,
}: {
  repoRoot: string | null;
  branch: string | null;
  onMergeDone?: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const { targets, status, loading, busy, mergeInto } = useRepoMergeStatus(
    repoRoot,
    branch,
    onMergeDone,
  );

  if (!repoRoot || targets.length === 0) return null;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-muted-foreground/70",
        className,
      )}
    >
      {loading && !status ? (
        <Spinner className="size-2.5" />
      ) : (
        status?.entries.map((entry) => {
          const targetBusy = busy === entry.name;
          const tooltip = (
            <TooltipContent
              side="top"
              className={cn(MERGE_TOOLTIP_CLASS, "text-[10.5px]")}
            >
              <span className="font-mono">{entry.name}</span>
              {!entry.error && (
                <span className="text-muted-foreground">
                  {entry.merged
                    ? t("sourceControl.merged")
                    : t("sourceControl.notMerged")}
                </span>
              )}
            </TooltipContent>
          );
          return (
            <Tooltip key={entry.name}>
              <TooltipTrigger asChild>
                {entry.error ? (
                  <span className="inline-flex cursor-default items-center">
                    <HugeiconsIcon
                      icon={Alert02Icon}
                      size={9}
                      strokeWidth={2}
                      className="text-muted-foreground/40"
                    />
                  </span>
                ) : entry.merged || targetBusy ? (
                  <span className="inline-flex cursor-default items-center">
                    {targetBusy ? (
                      <Spinner className="size-2.5" />
                    ) : (
                      <HugeiconsIcon
                        icon={CheckmarkCircle01Icon}
                        size={10}
                        strokeWidth={1.8}
                        className="text-muted-foreground/60"
                      />
                    )}
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={t("sourceControl.mergedIntoTarget", {
                      branch: status?.branch ?? branch ?? "",
                      target: entry.name,
                    })}
                    onClick={(e) => {
                      e.stopPropagation();
                      void mergeInto(entry.name);
                    }}
                    className="inline-flex cursor-pointer items-center rounded-sm transition-colors hover:text-foreground"
                  >
                    <HugeiconsIcon
                      icon={GitMergeIcon}
                      size={10}
                      strokeWidth={1.8}
                      className="text-muted-foreground/85"
                    />
                  </button>
                )}
              </TooltipTrigger>
              {tooltip}
            </Tooltip>
          );
        })
      )}
    </span>
  );
}
