import { create } from "zustand";
import { pluginBridge } from "./bridge";
import type { Plugin, PluginDispatchResult, PluginSnapshot } from "./types";
import type { PluginEvent, SpaceInfo } from "./events";

type PluginStore = {
  snapshot: PluginSnapshot;
  spaceInfo: Record<string, SpaceInfo>;
  /** Last dispatch error per plugin id, so failures are visible instead of silent. */
  lastErrorByPlugin: Record<string, string>;
  results: PluginDispatchResult[];
  load: () => Promise<void>;
  register: (plugin: Plugin) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  delete: (id: string) => Promise<void>;
  resetBuiltin: () => Promise<void>;
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
  lastErrorByPlugin: {},
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
      snapshot: normalize(
        state.snapshot.plugins.map((plugin) => ({
          ...plugin,
          enabled: plugin.id === id ? enabled : plugin.enabled,
        })),
      ),
    }));
  },
  delete: async (id) => {
    await pluginBridge.deletePlugin(id);
    set((state) => ({ snapshot: normalize(state.snapshot.plugins.filter((plugin) => plugin.id !== id)) }));
  },
  resetBuiltin: async () => {
    await pluginBridge.resetBuiltin();
    set({ snapshot: normalize(await pluginBridge.listPlugins()) });
  },
  entryRead: pluginBridge.entryRead,
  entryWrite: pluginBridge.entryWrite,
  dispatchEvent: async (event) => {
    let results: PluginDispatchResult[];
    try {
      results = await pluginBridge.dispatchEvent(event);
    } catch (error) {
      // IPC-level failure (unregistered command, ACL denial, panic in the
      // command) rejects here and used to swallow silently: no spaceInfo
      // update and no visible error. Surface it so something renders.
      console.error("[plugin] dispatchEvent failed", event?.type, error);
      set((state) => {
        const message = `dispatch failed: ${String(error)}`;
        const lastErrorByPlugin = { ...state.lastErrorByPlugin };
        for (const plugin of state.snapshot.plugins) {
          if (plugin.enabled) lastErrorByPlugin[plugin.id] = message;
        }
        return { lastErrorByPlugin };
      });
      return [];
    }
    set((state) => {
      const spaceInfo = { ...state.spaceInfo };
      const lastErrorByPlugin = { ...state.lastErrorByPlugin };
      let producedInfo = false;
      let producedError = false;
      for (const item of results) {
        if (item.result?.type === "space.info.updated") {
          spaceInfo[item.result.spaceId] = item.result.info;
          producedInfo = true;
        } else if (item.result?.type === "spaces.info.updated") {
          Object.assign(spaceInfo, item.result.spaces);
          producedInfo = true;
        }
        if (item.error) {
          lastErrorByPlugin[item.pluginId] = item.error;
          producedError = true;
        } else {
          delete lastErrorByPlugin[item.pluginId];
        }
      }
      if (results.length > 0 && !producedInfo && !producedError) {
        console.warn(
          "[plugin] dispatch produced no space-info and no error",
          event?.type,
          results,
        );
      }
      return { results, spaceInfo, lastErrorByPlugin };
    });
    return results;
  },
}));
