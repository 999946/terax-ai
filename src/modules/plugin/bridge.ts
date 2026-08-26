import { invoke } from "@tauri-apps/api/core";
import type { Plugin, PluginSnapshot, PluginDispatchResult } from "./types";
import type { PluginEvent } from "./events";

export const pluginBridge = {
  snapshot: () => invoke<PluginSnapshot>("plugin_snapshot"),
  listPlugins: () => invoke<Plugin[]>("plugin_list_plugins"),
  registerPlugin: (plugin: Plugin) => invoke<void>("plugin_register_plugin", { plugin }),
  setPluginEnabled: (id: string, enabled: boolean) => invoke<void>("plugin_set_plugin_enabled", { id, enabled }),
  deletePlugin: (id: string) => invoke<void>("plugin_delete_plugin", { id }),
  entryRead: (id: string) => invoke<string>("plugin_entry_read", { id }),
  entryWrite: (id: string, value: string) => invoke<void>("plugin_entry_write", { id, value }),
  dispatchEvent: (event: PluginEvent) =>
    invoke<PluginDispatchResult[]>("plugin_dispatch_event", { event }),
};
