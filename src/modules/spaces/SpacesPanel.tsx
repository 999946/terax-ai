import { useTranslation } from "react-i18next";
import type { Tab } from "@/modules/tabs";
import { useSpaces } from "./lib/useSpaces";
import { useSpacesPanel, SPACES_PANEL_WIDTH, SPACES_PANEL_COLLAPSED_WIDTH } from "./lib/useSpacesPanel";
import { cn } from "@/lib/utils";
import { SpaceAvatar } from "./SpaceAvatar";
import { SpaceSwitcherContent } from "./SpaceSwitcherContent";

type Props = {
  tabs: Tab[];
  onNewSpace: () => void;
  onDeleteSpace: (id: string) => void;
  onRenameSpace: (id: string, name: string) => void;
  onNewTabInSpace: (spaceId: string) => void;
  onActivateSpace: (spaceId: string) => void;
  onJumpTab: (id: number) => void;
  onCloseTab: (id: number) => void;
  onMoveTabToSpace: (tabId: number, spaceId: string) => void;
  onReorderTab: (tabId: number, targetTabId: number, edge: "top" | "bottom") => void;
  onReorderSpaces: (orderedIds: string[]) => void;
};

export function SpacesPanel({
  tabs,
  onNewSpace,
  onDeleteSpace,
  onRenameSpace,
  onNewTabInSpace,
  onActivateSpace,
  onJumpTab,
  onCloseTab,
  onMoveTabToSpace,
  onReorderTab,
  onReorderSpaces,
}: Props) {
  const { t } = useTranslation();
  const { collapsed, expand, collapse, scheduleCollapse, pinned, togglePinned } =
    useSpacesPanel();
  const spaces = useSpaces((s) => s.spaces);
  const activeId = useSpaces((s) => s.activeId);
  const activeSpace = spaces.find((s) => s.id === activeId);

  const handlePointerEnter = () => {
    expand();
  };

  const handlePointerLeave = () => {
    scheduleCollapse();
  };

  const handleTriggerClick = () => {
    if (collapsed) expand();
    else collapse();
  };

  return (
    <div
      className="relative shrink-0 border-r border-border/60 bg-card"
      style={{ width: collapsed ? SPACES_PANEL_COLLAPSED_WIDTH : SPACES_PANEL_WIDTH }}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {collapsed ? (
        <button
          type="button"
          aria-label={t("spaces.expandPanel", "Expand spaces")}
          aria-expanded={false}
          onClick={handleTriggerClick}
          className="flex w-full items-center justify-center py-3 text-muted-foreground hover:text-foreground transition-colors"
        >
          {activeSpace ? (
            <SpaceAvatar space={activeSpace} size="sm" />
          ) : (
            <span className="text-[10px] font-medium">S</span>
          )}
        </button>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/60">
            <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
              {t("spaces.title")}
            </span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                aria-label={
                  pinned
                    ? t("spaces.unpinPanel", "Unpin spaces")
                    : t("spaces.pinPanel", "Pin spaces open")
                }
                aria-pressed={pinned}
                onClick={togglePinned}
                className={cn(
                  "rounded p-1 transition-colors hover:bg-accent",
                  pinned
                    ? "text-primary hover:text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {pinned ? (
                    <>
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </>
                  ) : (
                    <>
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0 1 9.9-1" />
                    </>
                  )}
                </svg>
              </button>
              <button
                type="button"
                aria-label={t("spaces.collapsePanel", "Collapse spaces")}
                aria-expanded={true}
                onClick={collapse}
              className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M7 3L4 6L7 9" />
              </svg>
            </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SpaceSwitcherContent
              tabs={tabs}
              onNewSpace={onNewSpace}
              onDeleteSpace={onDeleteSpace}
              onRenameSpace={onRenameSpace}
              onNewTabInSpace={onNewTabInSpace}
              onActivateSpace={onActivateSpace}
              onJumpTab={onJumpTab}
              onCloseTab={onCloseTab}
              onMoveTabToSpace={onMoveTabToSpace}
              onReorderTab={onReorderTab}
              onReorderSpaces={onReorderSpaces}
            />
          </div>
        </div>
      )}
    </div>
  );
}