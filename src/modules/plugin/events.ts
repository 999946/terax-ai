export type PluginEventType =
  | "app.started"
  | "spaces.loaded"
  | "spaces.changed"
  | "space.activated"
  | "space.deactivated"
  | "file.saved";

export type SpaceContext = { id: string; name: string; root: string };
export type FileContext = {
  path: string;
  language: string | null;
  byteLength: number | null;
  isNew: boolean;
};
export type PluginEventContext = {
  eventId: string;
  eventType: PluginEventType;
  eventVersion: 1;
  emittedAt: string;
};
export type PluginEvent<T extends PluginEventType = PluginEventType> = {
  type: T;
  version: 1;
  payload: unknown;
  context?: PluginEventContext;
};
export type PluginEventResult =
  | { type: "handled" }
  | { type: "space.info.updated"; spaceId: string; info: SpaceInfo }
  | { type: "spaces.info.updated"; spaces: Record<string, SpaceInfo> };
export type SpaceInfo = {
  summary: string;
  status: "online" | "offline" | "degraded" | "unknown";
  onlineAt: string | null;
  lastTestedAt: string | null;
};
