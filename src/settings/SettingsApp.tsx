import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  type SettingsTab,
  useFloatingSettings,
} from "@/modules/settings/floatingSettingsStore";
import { useTranslation } from "react-i18next";
import {
  AiScanIcon,
  Cancel01Icon,
  InformationCircleIcon,
  KeyboardIcon,
  PaintBoardIcon,
  Settings01Icon,
  SourceCodeIcon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { lazy, Suspense, type ComponentType } from "react";

// The tab sections are lazy so the settings shell paints before the heavier
// panels (models / agents / plugin …) are parsed. Each tab's chunk is fetched
// only when the user opens that tab, keeping the first paint fast.
const LazyAboutSection = lazy(() =>
  import("./sections/AboutSection").then((m) => ({ default: m.AboutSection })),
);
const LazyAgentsSection = lazy(() =>
  import("./sections/AgentsSection").then((m) => ({ default: m.AgentsSection })),
);
const LazyEditorSection = lazy(() =>
  import("./sections/EditorSection").then((m) => ({ default: m.EditorSection })),
);
const LazyGeneralSection = lazy(() =>
  import("./sections/GeneralSection").then((m) => ({ default: m.GeneralSection })),
);
const LazyPluginSettings = lazy(() =>
  import("./sections/PluginSettings").then((m) => ({ default: m.PluginSettings })),
);
const LazyModelsSection = lazy(() =>
  import("./sections/ModelsSection").then((m) => ({ default: m.ModelsSection })),
);
const LazyShortcutsSection = lazy(() =>
  import("./sections/ShortcutsSection").then((m) => ({ default: m.ShortcutsSection })),
);
const LazyThemesSection = lazy(() =>
  import("./sections/ThemesSection").then((m) => ({ default: m.ThemesSection })),
);

const TABS: {
  id: SettingsTab;
  labelKey: string;
  icon: typeof Settings01Icon;
  component: ComponentType;
}[] = [
  {
    id: "general",
    labelKey: "settings.tabs.general",
    icon: Settings01Icon,
    component: LazyGeneralSection,
  },
  {
    id: "editor",
    labelKey: "settings.tabs.editor",
    icon: SourceCodeIcon,
    component: LazyEditorSection,
  },
  {
    id: "themes",
    labelKey: "settings.tabs.themes",
    icon: PaintBoardIcon,
    component: LazyThemesSection,
  },
  {
    id: "shortcuts",
    labelKey: "settings.tabs.shortcuts",
    icon: KeyboardIcon,
    component: LazyShortcutsSection,
  },
  {
    id: "models",
    labelKey: "settings.tabs.models",
    icon: AiScanIcon,
    component: LazyModelsSection,
  },
  {
    id: "agents",
    labelKey: "settings.tabs.agents",
    icon: UserMultiple02Icon,
    component: LazyAgentsSection,
  },
  {
    id: "plugin",
    labelKey: "settings.tabs.plugin",
    icon: SourceCodeIcon,
    component: LazyPluginSettings,
  },
  {
    id: "about",
    labelKey: "settings.tabs.about",
    icon: InformationCircleIcon,
    component: LazyAboutSection,
  },
];

export function SettingsApp() {
  const { t: translate } = useTranslation();
  const section = useFloatingSettings((s) => s.section);
  const setSection = useFloatingSettings((s) => s.setSection);
  const closeSettings = useFloatingSettings((s) => s.closeSettings);
  const ActiveSection = TABS.find((t) => t.id === section)?.component;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground select-none">
      <header className="flex h-11 shrink-0 items-center border-b border-border/60 bg-card/60 pl-3 pr-2">
        <Tabs
          value={section}
          onValueChange={(v) => setSection(v as SettingsTab)}
          orientation="horizontal"
          className="flex-1 items-center"
        >
          <TabsList className="mx-auto h-7 bg-muted/40 px-2">
            {TABS.map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                className="h-6 gap-1.5 px-2.5 text-[11.5px]"
              >
                <HugeiconsIcon icon={t.icon} size={12} strokeWidth={1.75} />
                <span>{translate(t.labelKey)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <button
          type="button"
          aria-label={translate("settings.close")}
          title={translate("settings.close")}
          onClick={closeSettings}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          )}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={2} />
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-7 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mx-auto w-full max-w-240">
          <Suspense
            fallback={
              <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
                Loading…
              </div>
            }
          >
            {ActiveSection && <ActiveSection />}
          </Suspense>
        </div>
      </main>
    </div>
  );
}
