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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Active,
  type Over,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { AgentIcon } from "@/modules/agents/lib/agentIcon";
import type { AgentLaunchRequest } from "@/modules/agents/lib/launcher";
import {
  ALL_LANGUAGES,
  EXPOSED_LANGUAGES,
} from "@/modules/editor/lib/languageDefinitions";
import { resolveDisplayName } from "@/modules/editor/lib/languageResolver";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  leafIds,
  ptyIdForLeaf,
  tabAgentStatus,
  useAgentActivityStore,
} from "@/modules/terminal";
import {
  ArrowRight01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  Clock01Icon,
  ComputerTerminal02Icon,
  GitCompareIcon,
  Globe02Icon,
  IncognitoIcon,
  Message02Icon,
  PencilEdit02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEventHandler,
  type TouchEventHandler,
  type ReactNode,
} from "react";
import { labelFor } from "./lib/tabLabel";
import type { EditorTab, Tab } from "./lib/useTabs";
import { NewTabMenu } from "./NewTabMenu";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onLaunchAgents: (request: AgentLaunchRequest) => void;
  onClose: (id: number) => void;
  /** Chrome-style: close every tab to the right of the given tab. */
  onCloseTabsToRight: (id: number) => void;
  /** Chrome-style: close every tab except the given tab. */
  onCloseOtherTabs: (id: number) => void;
  /** Close every tab in the given tab's space. */
  onCloseAll: (id: number) => void;
  /** Pin (promote) a preview tab to persistent on double-click. */
  onPin: (id: number) => void;
  /** Set a terminal tab's custom label; empty string resets to default. */
  onRename: (id: number, title: string) => void;
  /** Move a dragged tab to a new position (insertion gap index 0..tabs.length). */
  onReorder: (fromId: number, toGapIndex: number) => void;
  onOverrideLanguage?: (id: number, lang: string | null) => void;
  compact?: boolean;
};

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onNew,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onLaunchAgents,
  onClose,
  onCloseTabsToRight,
  onCloseOtherTabs,
  onCloseAll,
  onPin,
  onRename,
  onReorder,
  onOverrideLanguage,
  compact,
}: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [showAllLanguages, setShowAllLanguages] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
  );
  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs]);
  const activeDragTab =
    draggingId != null ? tabs.find((t) => t.id === draggingId) : undefined;

  // Play the enter animation only for tabs opened after the first paint, never
  // the restored set and never on switch/reorder (triggers are keyed, so they
  // don't remount then). The ref is seeded with the initial ids on first render.
  const seenRef = useRef<Set<number> | null>(null);
  const firstRender = seenRef.current === null;
  let seen = seenRef.current;
  if (seen === null) {
    seen = new Set(tabs.map((t) => t.id));
    seenRef.current = seen;
  }
  useEffect(() => {
    seenRef.current = new Set(tabs.map((t) => t.id));
  }, [tabs]);

  // Single shared pill slides to the active tab instead of each tab toggling
  // its own background. Measured relative to the list (its offsetParent) so it
  // scrolls with the strip for free; transform/width only, no layout on siblings.
  const [pill, setPill] = useState<{ left: number; width: number } | null>(
    null,
  );
  const [pillReady, setPillReady] = useState(false);

  const measurePill = useCallback(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      '[data-tab-active="true"]',
    );
    setPill(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
  }, []);

  useLayoutEffect(() => {
    measurePill();
  }, [measurePill, activeId, tabs]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const ro = new ResizeObserver(measurePill);
    ro.observe(list);
    return () => ro.disconnect();
  }, [measurePill]);

  // Hold the transition off until the pill is first placed, so it never slides
  // in from the origin on mount.
  useEffect(() => {
    if (pill && !pillReady) {
      const id = requestAnimationFrame(() => setPillReady(true));
      return () => cancelAnimationFrame(id);
    }
  }, [pill, pillReady]);

  const handleDragStart = ({ active }: { active: Active }) => {
    setDraggingId(active.id as number);
  };

  const handleDragCancel = () => {
    setDraggingId(null);
  };

  // dnd-kit reports `over.id` against the pre-drag ordering, so the over index
  // equals the visual index the dragged tab lands on — which is exactly what
  // `reorderTabsByGap`'s gap-index contract expects.
  const handleDragEnd = ({ active, over }: { active: Active; over: Over | null }) => {
    setDraggingId(null);
    if (!over || over.id === active.id) return;
    const overIndex = tabs.findIndex((t) => t.id === over.id);
    if (overIndex < 0) return;
    onReorder(active.id as number, overIndex);
  };

  // Horizontal wheel scroll without holding shift.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab visible after selection / open.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  return (
    <div
      ref={scrollRef}
      data-tauri-drag-region
      className="min-w-0 shrink overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex w-max items-center gap-0.5">
        <Tabs
          value={String(activeId)}
          onValueChange={(v) => onSelect(Number(v))}
        >
          <TabsList
            ref={listRef}
            className="relative h-7 w-max gap-0.5 bg-transparent p-0"
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <SortableContext
                items={tabIds}
                strategy={horizontalListSortingStrategy}
              >
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-0 top-1/2 h-7 rounded-md bg-foreground/[0.07] shadow-sm ring-1 ring-inset ring-foreground/[0.05]"
                  style={
                    pill
                      ? {
                          width: pill.width,
                          transform: `translate(${pill.left}px, -50%)`,
                          transitionProperty: pillReady
                            ? "transform, width"
                            : "none",
                          transitionDuration: "var(--dur-base)",
                          transitionTimingFunction: "var(--ease-premium)",
                        }
                      : { opacity: 0 }
                  }
                />
            {tabs.map((tab, i) => {
              const isPreview =
                (tab.kind === "editor" || tab.kind === "git-diff") && tab.preview;
              const isActive = tab.id === activeId;
              const isNew = !firstRender && !seen.has(tab.id);

              // While renaming, render a non-button cell so the <input> is not
              // nested inside the trigger <button> (invalid HTML, and WebKit
              // blocks focus/selection on inputs inside buttons).
              if (editingId === tab.id && tab.kind === "terminal") {
                return (
                  <SortableTabNode key={tab.id} id={tab.id}>
                    <div
                      data-tab-id={tab.id}
                      className={cn(
                        "flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent text-xs text-foreground",
                        compact ? "px-1.5" : "px-2",
                      )}
                    >
                      <TabIcon tab={tab} />
                      <TabRenameInput
                        initial={labelFor(tab)}
                        onCommit={(value) => {
                          onRename(tab.id, value);
                          setEditingId(null);
                        }}
                        onCancel={() => setEditingId(null)}
                      />
                    </div>
                  </SortableTabNode>
                );
              }

              const trigger = (
                <TabsTrigger
                  value={String(tab.id)}
                  data-tab-id={tab.id}
                  data-tab-active={isActive ? "true" : undefined}
                  onDoubleClick={() => isPreview && onPin(tab.id)}
                  onAuxClick={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      e.stopPropagation();
                      onClose(tab.id);
                    }
                  }}
                  // Only suppress the middle-click default; the left click lets
                  // Radix activate normally (selection on mousedown), while
                  // dragging is handled by dnd-kit's pointer sensor.
                  onMouseDown={(e) => {
                    if (e.button === 1) e.preventDefault();
                  }}
                  className={cn(
                    "group relative z-[1] h-7 shrink-0 justify-between gap-1.5 rounded-md bg-transparent text-xs transition-colors data-active:bg-transparent dark:data-active:bg-transparent",
                    isNew && "terax-tab-in",
                    isActive
                      ? "text-foreground dark:text-foreground"
                      : "text-muted-foreground hover:text-foreground/80 dark:text-muted-foreground",
                    draggingId === tab.id && "opacity-50",
                    compact
                      ? "px-1.5!"
                      : tabs.length === 1
                        ? "px-2!"
                        : "ps-2! pe-1!",
                  )}
                >
                  <span
                    className={cn(
                      "flex min-w-0 items-center gap-1.5",
                      compact ? "max-w-48" : "max-w-80",
                    )}
                  >
                    {tab.kind === "editor" ? (
                      <DropdownMenu
                        onOpenChange={(open) => {
                          if (!open) setShowAllLanguages(false);
                        }}
                      >
                        <DropdownMenuTrigger asChild>
                          {/* span, not button: a button nested in the TabsTrigger button is invalid DOM and breaks WebKit focus. */}
                          <span
                            role="button"
                            tabIndex={-1}
                            data-no-drag
                            onPointerDown={(e) => e.stopPropagation()}
                            onMouseDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                            className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm p-1 -m-1 transition-all hover:bg-accent hover:text-accent-foreground hover:ring-1 hover:ring-primary/30 hover:shadow-[0_0_4px_var(--color-popover-foreground)]"
                          >
                            <TabIcon tab={tab} />
                          </span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          side="bottom"
                          sideOffset={6}
                          alignOffset={-4}
                          className="max-h-75 w-48 overflow-y-auto rounded-xl border border-border/40 bg-popover/90 p-1 backdrop-blur-md shadow-lg"
                          onClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => e.stopPropagation()}
                          onPointerUp={(e) => e.stopPropagation()}
                        >
                          <DropdownMenuItem
                            onSelect={() => {
                              onOverrideLanguage?.(tab.id, null);
                            }}
                            className="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-lg cursor-default focus:bg-accent focus:text-accent-foreground"
                          >
                            <img
                              src={fileIconUrl(tab.title)}
                              className="size-3.5 shrink-0 object-contain"
                              alt=""
                            />
                            <div className="flex flex-1 flex-col">
                              <span>{t("tabs.autoDetect")}</span>
                              <span className="text-[10px] text-muted-foreground italic">
                                {t("tabs.mode", { language: resolveDisplayName(tab.title) })}
                              </span>
                            </div>
                            {!(tab as EditorTab).overrideLanguage && (
                              <HugeiconsIcon
                                icon={Tick02Icon}
                                className="size-3.5 text-primary"
                              />
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={(e) => {
                              e.preventDefault();
                              setShowAllLanguages((v) => !v);
                            }}
                            className="w-full px-2.5 py-1.5 text-left text-xs text-primary/60 hover:text-primary rounded-lg transition-colors hover:bg-accent"
                          >
                            {showAllLanguages
                              ? t("tabs.fewerLanguages")
                              : t("tabs.allLanguages")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator className="my-1 border-t border-border/30" />
                          {(showAllLanguages
                            ? ALL_LANGUAGES
                            : EXPOSED_LANGUAGES
                          ).map((lang) => {
                            const isSelected =
                              (tab as EditorTab).overrideLanguage === lang.ext;
                            return (
                              <DropdownMenuItem
                                key={lang.ext}
                                onSelect={() =>
                                  onOverrideLanguage?.(tab.id, lang.ext)
                                }
                                className="flex items-center gap-2 px-2.5 py-1.5 text-xs rounded-lg cursor-default focus:bg-accent focus:text-accent-foreground"
                              >
                                <img
                                  src={fileIconUrl(`dummy.${lang.ext}`)}
                                  className="size-3.5 shrink-0 object-contain"
                                  alt=""
                                />
                                <span className="flex-1">{lang.name}</span>
                                {isSelected && (
                                  <HugeiconsIcon
                                    icon={Tick02Icon}
                                    className="size-3.5 text-primary"
                                  />
                                )}
                              </DropdownMenuItem>
                            );
                          })}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : (
                      <TabIcon tab={tab} />
                    )}
                    {/* Preview tabs use italic to signal the transient state,
                        matching the visual convention from VSCode. */}
                    <span className={cn("truncate", isPreview && "italic")}>
                      {labelFor(tab)}
                    </span>
                    {tab.kind === "editor" && tab.dirty ? (
                      <span
                        aria-label={t("tabs.unsavedChanges")}
                        className="size-1.5 shrink-0 rounded-full bg-foreground/70"
                      />
                    ) : null}
                  </span>
                  <span
                    role="button"
                    aria-label={t("tabs.closeTab")}
                    data-no-drag
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.id);
                    }}
                    className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent hover:opacity-100 group-hover:opacity-60"
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      size={11}
                      strokeWidth={2}
                    />
                  </span>
                </TabsTrigger>
              );

              const hasTabsToRight = i < tabs.length - 1;

              const tabNode = (
                <ContextMenu>
                  <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
                  <ContextMenuContent
                    className="min-w-32 p-1"
                    onCloseAutoFocus={(e) => e.preventDefault()}
                  >
                    {tab.kind === "terminal" && (
                      <>
                        <ContextMenuItem
                          className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
                          onSelect={() => setEditingId(tab.id)}
                        >
                          <HugeiconsIcon
                            icon={PencilEdit02Icon}
                            size={13}
                            strokeWidth={1.75}
                          />
                          <span className="flex-1">{t("tabs.rename")}</span>
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
                          onSelect={() => onClose(tab.id)}
                        >
                          <HugeiconsIcon
                            icon={Cancel01Icon}
                            size={13}
                            strokeWidth={1.75}
                          />
                          <span className="flex-1">{t("tabs.close")}</span>
                        </ContextMenuItem>
                      </>
                    )}
                    <ContextMenuItem
                      className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
                      disabled={!hasTabsToRight}
                      onSelect={() => onCloseTabsToRight(tab.id)}
                    >
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        size={13}
                        strokeWidth={1.75}
                      />
                      <span className="flex-1">{t("tabs.closeTabsToRight")}</span>
                    </ContextMenuItem>
                    <ContextMenuItem
                      className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
                      disabled={tabs.length <= 1}
                      onSelect={() => onCloseOtherTabs(tab.id)}
                    >
                      <HugeiconsIcon
                        icon={CancelCircleIcon}
                        size={13}
                        strokeWidth={1.75}
                      />
                      <span className="flex-1">{t("tabs.closeOtherTabs")}</span>
                    </ContextMenuItem>
                    <ContextMenuItem
                      className="gap-2 rounded-xl px-2.5 py-1.5 text-[13px]"
                      disabled={tabs.length === 0}
                      onSelect={() => onCloseAll(tab.id)}
                    >
                      <HugeiconsIcon
                        icon={CancelCircleIcon}
                        size={13}
                        strokeWidth={1.75}
                      />
                      <span className="flex-1">{t("tabs.closeAllTabs")}</span>
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );

              return (
                <SortableTabNode key={tab.id} id={tab.id}>
                  {tabNode}
                </SortableTabNode>
              );
            })}
              </SortableContext>
              <DragOverlay dropAnimation={null}>
                {activeDragTab ? (
                  <div className="flex h-7 w-max items-center gap-1.5 rounded-md bg-card px-2 text-xs text-foreground shadow-lg ring-1 ring-border/70">
                    <TabIcon tab={activeDragTab} />
                    <span className="whitespace-nowrap">
                      {labelFor(activeDragTab)}
                    </span>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          </TabsList>
        </Tabs>
        <NewTabMenu
          onNew={onNew}
          onNewBlock={onNewBlock}
          onNewPrivate={onNewPrivate}
          onNewPreview={onNewPreview}
          onNewEditor={onNewEditor}
          onNewGitGraph={onNewGitGraph}
          onLaunchAgents={onLaunchAgents}
        />
      </div>
    </div>
  );
}

// Sortable wrapper for a tab: applies dnd-kit's drag transform so the strip
// shifts smoothly as items are reordered, and dims the source tab while it's
// being dragged (the visual "ghost" follows the cursor in the DragOverlay).
function SortableTabNode({
  id,
  children,
}: {
  id: number;
  children: ReactNode;
}) {
  const { setNodeRef, transform, transition, isDragging, listeners } =
    useSortable({ id });
  // Only the pointer handlers are attached — dropping onKeyDown keeps drag
  // keyboard-only-free so Space/Enter still activate the tab button (no
  // KeyboardSensor is registered deliberately).
  const { onPointerDown, onTouchStart } = listeners ?? {};
  const handlePointerDown = onPointerDown as
    | PointerEventHandler<HTMLDivElement>
    | undefined;
  const handleTouchStart = onTouchStart as
    | TouchEventHandler<HTMLDivElement>
    | undefined;
  return (
    <div
      ref={setNodeRef}
      onPointerDown={handlePointerDown}
      onTouchStart={handleTouchStart}
      className="shrink-0"
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : undefined,
        zIndex: isDragging ? 2 : undefined,
      }}
    >
      {children}
    </div>
  );
}

function useTabAgentStatus(tab: Tab) {
  const phases = useAgentActivityStore((s) => s.phases);
  const agents = useAgentActivityStore((s) => s.agents);
  if (tab.kind !== "terminal" || tab.private) {
    return { state: null, agent: null } as const;
  }
  const ptyIds: number[] = [];
  for (const leaf of leafIds(tab.paneTree)) {
    const id = ptyIdForLeaf(leaf);
    if (id !== null) ptyIds.push(id);
  }
  return tabAgentStatus(phases, agents, ptyIds);
}

export function TabIcon({ tab }: { tab: Tab }) {
  const agentStatus = useTabAgentStatus(tab);
  if (tab.kind === "editor") {
    const url =
      tab.kind === "editor" && tab.overrideLanguage
        ? fileIconUrl(`dummy.${tab.overrideLanguage}`)
        : fileIconUrl(tab.title);
    return url ? (
      <img
        src={url}
        alt=""
        className="size-3.5 shrink-0 object-contain"
        onError={(e) => {
          const img = e.currentTarget;
          if (img.dataset.fallback) return;
          img.dataset.fallback = "1";
          img.src = fileIconUrl("dummy.txt");
        }}
      />
    ) : null;
  }
  if (tab.kind === "preview") {
    return (
      <HugeiconsIcon
        icon={Globe02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "ai-diff") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "terminal" && tab.private) {
    return (
      <HugeiconsIcon
        icon={IncognitoIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-diff" || tab.kind === "git-commit-file") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-history") {
    return (
      <HugeiconsIcon
        icon={Clock01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (agentStatus.state === "attention") {
    return (
      <HugeiconsIcon
        icon={Message02Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (agentStatus.state === "finished") {
    return (
      <HugeiconsIcon
        icon={CheckmarkCircle01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (
    (agentStatus.state === "working" || agentStatus.state === "idle") &&
    agentStatus.agent
  ) {
    return (
      <AgentIcon agent={agentStatus.agent} size={14} className="shrink-0" />
    );
  }
  return (
    <HugeiconsIcon
      icon={ComputerTerminal02Icon}
      size={14}
      strokeWidth={2}
      className="shrink-0"
    />
  );
}

function TabRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  // Guards against a trailing blur re-resolving an edit that Enter/Escape
  // already finished (Escape must never commit).
  const done = useRef(false);

  useEffect(() => {
    // Focus on the next frame so it runs after the context menu restores focus
    // to its trigger when closing; a synchronous focus would be stolen.
    const raf = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const finish = (fn: () => void) => {
    if (done.current) return;
    done.current = true;
    fn();
  };

  // explicit = the user pressed Enter, which pins even the unchanged label. A
  // plain blur with no change must not freeze the cwd-derived default into a
  // custom title.
  const commit = (value: string, explicit: boolean) => {
    if (!explicit && value.trim() === initial.trim()) finish(onCancel);
    else finish(() => onCommit(value));
  };

  return (
    <input
      ref={ref}
      defaultValue={initial}
      aria-label={t("tabs.renameTab")}
      className={cn(
        "w-28 min-w-0 rounded-sm bg-background px-1 text-xs text-foreground",
        "outline-none ring-1 ring-border focus:ring-ring",
      )}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit(e.currentTarget.value, true);
        else if (e.key === "Escape") finish(onCancel);
      }}
      onBlur={(e) => {
        // Switching windows/apps blurs the input; keep the edit open instead
        // of resolving it on the way out.
        if (!document.hasFocus()) return;
        commit(e.currentTarget.value, false);
      }}
    />
  );
}
