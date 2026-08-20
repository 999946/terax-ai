import { useTranslation } from "react-i18next";
import type { Tab } from "@/modules/tabs";
import { useSpaces } from "./lib/useSpaces";
import { useSpacesPanel, SPACES_PANEL_WIDTH, SPACES_PANEL_COLLAPSED_WIDTH } from "./lib/useSpacesPanel";
import { SpaceAvatar } from "./SpaceAvatar";
import { SpaceSwitcherContent } from "./SpaceSwitcherContent";

type Props = {
  tabs: Tab[];
  onNewSpace: () => void;
  onDeleteSpace: (id: string) => void;
  onNewTabInSpace: (spaceId: string) => void;
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
  onNewTabInSpace,
  onJumpTab,
  onCloseTab,
  onMoveTabToSpace,
  onReorderTab,
  onReorderSpaces,
}: Props) {
  const { t } = useTranslation();
  const { collapsed, expand, collapse, scheduleCollapse } = useSpacesPanel();
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
          <div className="min-h-0 flex-1 overflow-y-auto">
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
          </div>
        </div>
      )}
    </div>
  );
}