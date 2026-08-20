import { useTranslation } from "react-i18next";
import { useShortcutLabel } from "@/modules/shortcuts";
import { type Tab } from "@/modules/tabs";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Kbd } from "@/components/ui/kbd";
import { useSpaces } from "./lib/useSpaces";
import { SpaceSwitcherContent } from "./SpaceSwitcherContent";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: Tab[];
  onNewSpace: () => void;
  onDeleteSpace: (id: string) => void;
  onNewTabInSpace: (spaceId: string) => void;
  onJumpTab: (id: number) => void;
  onCloseTab: (id: number) => void;
  onMoveTabToSpace: (tabId: number, spaceId: string) => void;
  onReorderTab: (
    tabId: number,
    targetTabId: number,
    edge: "top" | "bottom",
  ) => void;
  onReorderSpaces: (orderedIds: string[]) => void;
};

export function SpaceSwitcher({
  open,
  onOpenChange,
  tabs,
  onNewSpace,
  onDeleteSpace,
  onNewTabInSpace,
  onJumpTab,
  onCloseTab,
  onMoveTabToSpace,
  onReorderTab,
  onReorderSpaces,
}: Props) {
  const { t } = useTranslation();
  const spaces = useSpaces((s) => s.spaces);
  const activeId = useSpaces((s) => s.activeId);
  const shortcut = useShortcutLabel("space.overview");
  const current = spaces.find((s) => s.id === activeId);

  if (!current) return null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={shortcut ? `${t("spaces.title")} · ${shortcut}` : t("spaces.title")}
          className="flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-muted-foreground/90 outline-none transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <span className="max-w-36 truncate text-xs font-medium">
            {current.name}
          </span>
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={14}
            strokeWidth={1.75}
            className="shrink-0 opacity-65"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-1.5">
        <div className="flex items-center justify-between px-1.5 pb-1.5 pt-0.5">
          <span className="text-xs font-semibold text-foreground">{t("spaces.title")}</span>
          {shortcut && (
            <Kbd className="h-5 bg-muted/70 text-[10px]">{shortcut}</Kbd>
          )}
        </div>
        <SpaceSwitcherContent
          tabs={tabs}
          onNewSpace={onNewSpace}
          onDeleteSpace={onDeleteSpace}
          onNewTabInSpace={onNewTabInSpace}
          onJumpTab={onJumpTab}
          onCloseTab={onCloseTab}
          onMoveTabToSpace={onMoveTabToSpace}
          onReorderTab={onReorderTab}
          onReorderSpaces={onReorderSpaces}
        />
      </PopoverContent>
    </Popover>
  );
}