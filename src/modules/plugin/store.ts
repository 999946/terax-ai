import { create } from "zustand";
import { pluginBridge } from "./bridge";
import type { Plugin, PluginDispatchResult, PluginSnapshot } from "./types";
import type { PluginEvent, SpaceInfo } from "./events";

type PluginStore = {
  snapshot: PluginSnapshot;
  spaceInfo: Record<string, SpaceInfo>;
  results: PluginDispatchResult[];
  load: () => Promise<void>;
  register: (plugin: Plugin) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  delete: (id: string) => Promise<void>;
  entryRead: (id: string) => Promise<string>;
  entryWrite: (id: string, value: string) => Promise<void>;
  dispatchEvent: (event: PluginEvent) => Promise<PluginDispatchResult[]>;
};

const emptySnapshot: PluginSnapshot = { plugins: [], enabledCount: 0, totalCount: 0 };
const normalize = (plugins: Plugin[]): PluginSnapshot => ({
  plugins,
  totalCount: plugins.length,
  enabledCount: plugins.filter((plugin) => plugin.enabled).length,
});
let loadPromise: Promise<void> | null = null;

export const usePluginStore = create<PluginStore>((set) => ({
  snapshot: emptySnapshot,
  spaceInfo: {},
  results: [],
  load: async () => {
    if (loadPromise) return loadPromise;
    loadPromise = pluginBridge.listPlugins().then((plugins) => set({ snapshot: normalize(plugins) }));
    return loadPromise;
  },
  register: async (plugin) => {
    await pluginBridge.registerPlugin(plugin);
    set({ snapshot: normalize(await pluginBridge.listPlugins()) });
  },
  setEnabled: async (id, enabled) => {
    await pluginBridge.setPluginEnabled(id, enabled);
    set((state) => ({
      snapshot: normalize(state.snapshot.plugins.map((plugin) => ({
        ...plugin,
        enabled: plugin.id === id ? enabled : enabled ? false : plugin.enabled,
      }))),
    }));
  },
  delete: async (id) => {
    await pluginBridge.deletePlugin(id);
    set((state) => ({ snapshot: normalize(state.snapshot.plugins.filter((plugin) => plugin.id !== id)) }));
  },
  entryRead: pluginBridge.entryRead,
  entryWrite: pluginBridge.entryWrite,
  dispatchEvent: async (event) => {
    const results = await pluginBridge.dispatchEvent(event);
    set((state) => {
      const spaceInfo = { ...state.spaceInfo };
      for (const item of results) {
        if (item.result?.type === "space.info.updated") {
          spaceInfo[item.result.spaceId] = item.result.info;
        } else if (item.result?.type === "spaces.info.updated") {
          Object.assign(spaceInfo, item.result.spaces);
        }
      }
      return { results, spaceInfo };
    });
    return results;
  },
}));
