import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  ArrowUpRight01Icon,
  CollapseIcon,
  LayoutTwoColumnIcon,
  ListViewIcon,
  RefreshIcon,
  Settings02Icon,
  SquareLock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useShortcutLabel } from "@/modules/shortcuts";
import {
  HIGHLIGHT_OPTIONS,
  IGNORE_OPTIONS,
  type DiffHighlightPolicy,
  type DiffIgnorePolicy,
  type DiffViewerOptions,
} from "./lib/diffOptions";

type Props = {
  options: DiffViewerOptions;
  /** e.g. "3 of 7 differences", "No differences". */
  summary: string;
  onChange: (patch: Partial<DiffViewerOptions>) => void;
  onPrevious: () => void;
  onNext: () => void;
  onRefresh: () => void;
  onJumpToSource?: () => void;
  /** Diff blocks available; disables the navigation arrows when zero. */
  differenceCount: number;
  /** Hidden for the fallback (binary / huge) views, which have no block count. */
  hideCounter?: boolean;
  /** Bumped to open the settings menu from a keyboard shortcut. */
  settingsRequest?: number;
};

/** A toolbar icon button that reflects a pressed (active) state. */
function ToolButton({
  icon,
  label,
  shortcut,
  onClick,
  pressed,
  disabled,
}: {
  icon: typeof ArrowUp01Icon;
  label: string;
  /** Rendered after the label in the tooltip, as IDEA does. */
  shortcut?: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
}) {
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      aria-keyshortcuts={shortcut}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded transition-colors",
        "text-muted-foreground hover:bg-accent hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-40",
        pressed && "bg-accent text-foreground",
      )}
    >
      <HugeiconsIcon icon={icon} size={13} strokeWidth={1.8} />
    </button>
  );
}

function Separator() {
  return <span className="terax-diff-sep mx-1 h-3.5 w-px shrink-0 bg-border" />;
}

/**
 * IDEA's diff toolbar (OpenIDEA `DiffEditor`'s): difference navigation, viewer
 * kind, whitespace / highlighting policies, collapsing, scroll sync, refresh,
 * the difference counter, and a settings menu that repeats every viewer option.
 */
export function DiffToolbar({
  options,
  summary,
  onChange,
  onPrevious,
  onNext,
  onRefresh,
  onJumpToSource,
  differenceCount,
  hideCounter,
  settingsRequest = 0,
}: Props) {
  const { t } = useTranslation();
  const split = options.mode === "split";
  const [settingsOpen, setSettingsOpen] = useState(false);
  const prevShortcut = useShortcutLabel("diff.prevDifference");
  const nextShortcut = useShortcutLabel("diff.nextDifference");
  const sourceShortcut = useShortcutLabel("diff.jumpToSource");
  const settingsShortcut = useShortcutLabel("diff.showSettings");

  // ⇧⌥D opens the gear menu from the pane's keydown handler. (IDEA uses ⇧⌘D,
  // already taken here by "split pane down".) The counter is the imperative
  // channel, so no ref plumbing is needed.
  useEffect(() => {
    if (settingsRequest > 0) setSettingsOpen(true);
  }, [settingsRequest]);

  return (
    <div
      role="toolbar"
      aria-label={t("editor.diffToolbar")}
      className="terax-diff-toolbar flex h-9 shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5"
    >
      <ToolButton
        icon={ArrowUp01Icon}
        label={t("editor.diffPreviousDifference")}
        shortcut={prevShortcut}
        onClick={onPrevious}
        disabled={differenceCount === 0}
      />
      <ToolButton
        icon={ArrowDown01Icon}
        label={t("editor.diffNextDifference")}
        shortcut={nextShortcut}
        onClick={onNext}
        disabled={differenceCount === 0}
      />
      {onJumpToSource ? (
        <ToolButton
          icon={ArrowUpRight01Icon}
          label={t("editor.diffJumpToSource")}
          shortcut={sourceShortcut}
          onClick={onJumpToSource}
        />
      ) : null}

      <Separator />

      <ToolButton
        icon={LayoutTwoColumnIcon}
        label={t("editor.diffViewSplit")}
        pressed={split}
        onClick={() => onChange({ mode: "split" })}
      />
      <ToolButton
        icon={ListViewIcon}
        label={t("editor.diffViewInline")}
        pressed={!split}
        onClick={() => onChange({ mode: "inline" })}
      />

      <Separator />

      <Select
        value={options.ignore}
        onValueChange={(value) =>
          onChange({ ignore: value as DiffIgnorePolicy })
        }
      >
        <SelectTrigger
          className="terax-diff-select h-6 w-[148px] shrink-0 text-[11px]"
          aria-label={t("editor.diffIgnoreWhitespace")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {IGNORE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={options.highlight}
        onValueChange={(value) =>
          onChange({ highlight: value as DiffHighlightPolicy })
        }
      >
        <SelectTrigger
          className="terax-diff-select h-6 w-[124px] shrink-0 text-[11px]"
          aria-label={t("editor.diffHighlighting")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {HIGHLIGHT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <ToolButton
        icon={CollapseIcon}
        label={t("editor.diffCollapseUnchanged")}
        pressed={options.collapse}
        onClick={() => onChange({ collapse: !options.collapse })}
      />
      {split ? (
        <ToolButton
          icon={SquareLock01Icon}
          label={t("editor.diffSyncScroll")}
          pressed={options.syncScroll}
          onClick={() => onChange({ syncScroll: !options.syncScroll })}
        />
      ) : null}

      <Separator />

      <ToolButton
        icon={RefreshIcon}
        label={t("editor.diffRefresh")}
        onClick={onRefresh}
      />

      {!hideCounter ? (
        <span
          className="ml-auto min-w-0 shrink truncate px-1.5 text-[11px] tabular-nums text-muted-foreground"
          role="status"
        >
          {summary}
        </span>
      ) : (
        <span className="ml-auto" />
      )}

      <DropdownMenu open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={
              settingsShortcut
                ? `${t("editor.diffSettings")} (${settingsShortcut})`
                : t("editor.diffSettings")
            }
            aria-keyshortcuts={settingsShortcut}
            aria-label={t("editor.diffSettings")}
            aria-haspopup="menu"
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <HugeiconsIcon icon={Settings02Icon} size={13} strokeWidth={1.8} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuLabel className="py-1.5">
            {t("editor.diffSettingsViewer")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={options.mode}
            onValueChange={(value) =>
              onChange({ mode: value === "inline" ? "inline" : "split" })
            }
          >
            <DropdownMenuRadioItem value="split">
              {t("editor.diffViewSplit")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="inline">
              {t("editor.diffViewInline")}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>

          <DropdownMenuSeparator />

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {t("editor.diffIgnoreWhitespace")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={options.ignore}
                onValueChange={(value) =>
                  onChange({ ignore: value as DiffIgnorePolicy })
                }
              >
                {IGNORE_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.value}
                    value={option.value}
                  >
                    {t(option.labelKey)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              {t("editor.diffHighlighting")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup
                value={options.highlight}
                onValueChange={(value) =>
                  onChange({ highlight: value as DiffHighlightPolicy })
                }
              >
                {HIGHLIGHT_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.value}
                    value={option.value}
                  >
                    {t(option.labelKey)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          <DropdownMenuCheckboxItem
            checked={options.collapse}
            onCheckedChange={(checked) => onChange({ collapse: checked })}
          >
            {t("editor.diffCollapseUnchanged")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={options.syncScroll}
            disabled={!split}
            onCheckedChange={(checked) => onChange({ syncScroll: checked })}
          >
            {t("editor.diffSyncScroll")}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={options.alignChanges}
            disabled={!split}
            onCheckedChange={(checked) => onChange({ alignChanges: checked })}
          >
            {t("editor.diffAlignChanges")}
          </DropdownMenuCheckboxItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={onRefresh}>
            {t("editor.diffRefresh")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
