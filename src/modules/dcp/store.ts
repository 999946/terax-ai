import { create } from "zustand";
import { dcpBridge } from "./bridge";
import type { DcpPlugin, DcpSnapshot } from "./types";

type DcpStore = {
  snapshot: DcpSnapshot;
  load: () => Promise<void>;
  register: (plugin: DcpPlugin) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  delete: (id: string) => Promise<void>;
  entryRead: (id: string, entry: string) => Promise<unknown>;
  entryWrite: (id: string, entry: string, value: unknown) => Promise<unknown>;
};

const emptySnapshot: DcpSnapshot = { plugins: [], enabledCount: 0, totalCount: 0 };
const normalize = (value: DcpSnapshot | DcpPlugin[] | null | undefined): DcpSnapshot => {
  const plugins = Array.isArray(value) ? value : value?.plugins;
  if (!Array.isArray(plugins)) return emptySnapshot;
  return {
    plugins,
    totalCount: plugins.length,
    enabledCount: plugins.filter((p) => p.enabled).length,
  };
};

let loadPromise: Promise<void> | null = null;

export const useDcpStore = create<DcpStore>((set) => ({
  snapshot: emptySnapshot,
  load: async () => {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        set({ snapshot: normalize(await dcpBridge.snapshot()) });
      } catch {
        try {
          set({ snapshot: normalize(await dcpBridge.listPlugins()) });
        } catch {
          set({ snapshot: emptySnapshot });
        }
      }
    })();
    return loadPromise;
  },
  register: async (plugin) => { await dcpBridge.registerPlugin(plugin); set({ snapshot: normalize(await dcpBridge.listPlugins()) }); },
  setEnabled: async (id, enabled) => { await dcpBridge.setPluginEnabled(id, enabled); set((s) => ({ snapshot: normalize(s.snapshot.plugins.map((p) => ({ ...p, enabled: p.id === id ? enabled : (enabled ? false : p.enabled) }))) })); },
  delete: async (id) => { await dcpBridge.deletePlugin(id); set((s) => ({ snapshot: normalize(s.snapshot.plugins.filter((p) => p.id !== id)) })); },
  entryRead: dcpBridge.entryRead,
  entryWrite: dcpBridge.entryWrite,
}));
