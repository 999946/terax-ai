import type { PluginEventResult } from "./events";

export type Plugin = {
  id: string;
  name: string;
  content: string;
  schemaVersion: 1;
  enabled: boolean;
};
export type PluginSnapshot = {
  plugins: Plugin[];
  enabledCount: number;
  totalCount: number;
};
export type PluginDispatchResult = {
  pluginId: string;
  result?: PluginEventResult;
  error?: string;
};
