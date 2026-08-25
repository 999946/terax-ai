import { invoke } from "@tauri-apps/api/core";
import type { DcpEvent, DcpPlugin, DcpSnapshot } from "./types";

export const dcpBridge = {
  snapshot: () => invoke<DcpSnapshot>("dcp_snapshot"),
  listPlugins: () => invoke<DcpPlugin[]>("dcp_list_plugins"),
  registerPlugin: (plugin: DcpPlugin) => invoke<void>("dcp_register_plugin", { plugin }),
  setPluginEnabled: (id: string, enabled: boolean) => invoke<void>("dcp_set_plugin_enabled", { id, enabled }),
  deletePlugin: (id: string) => invoke<void>("dcp_delete_plugin", { id }),
  entryRead: (id: string, entry: string) => invoke<unknown>("dcp_entry_read", { id, entry }),
  entryWrite: (id: string, entry: string, value: unknown) => invoke<unknown>("dcp_entry_write", { id, entry, value }),
  refresh: (id?: string) => invoke<DcpEvent[]>("dcp_refresh", { id: id ?? null }),
};
