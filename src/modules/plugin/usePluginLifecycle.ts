import { useEffect, useRef } from "react";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import { usePluginStore } from "./store";
import type { PluginEvent, PluginEventType } from "./events";

let eventSequence = 0;

function makeEvent(type: PluginEventType, payload: unknown): PluginEvent {
  return {
    type,
    version: 1,
    payload,
    context: {
      eventId: `${type}-${++eventSequence}-${Date.now().toString(36)}`,
      eventType: type,
      eventVersion: 1,
      emittedAt: new Date().toISOString(),
    },
  };
}

/**
 * Dispatches plugin lifecycle events and mirrors any plugin-produced
 * SpaceInfo back into the spaces store so the space list UI can render it.
 *
 * A single subscription on the plugin store copies `spaceInfo` entries into
 * the spaces store whenever they change, so results arriving from any event
 * (spaces.loaded, space.activated, ...) surface immediately without re-dispatch
 * loops. Lifecycle events are fired once per transition so repeat triggers stay
 * idempotent.
 */
export function usePluginLifecycle({
  spacesHydrated,
  spaces,
  activeSpaceId,
}: {
  spacesHydrated: boolean;
  spaces: { id: string; name: string; root: string | null }[];
  activeSpaceId: string | null;
}): void {
  const lastActiveSpaceId = useRef<string | null>(null);
  const loadedOnce = useRef(false);
  // Mirror plugin-produced SpaceInfo into the spaces store on any plugin-store
  // change. Live subscription avoids effect loops from `spaces` in deps.
  useEffect(() => {
    if (!spacesHydrated) return;
    return usePluginStore.subscribe((state) => {
      const info = state.spaceInfo;
      useSpaces.setState((spacesState) => {
        const spaces = spacesState.spaces;
        let changed = false;
        const next = spaces.map((s) => {
          const entry = info[s.id];
          if (entry && s.info !== entry) {
            changed = true;
            return { ...s, info: entry };
          }
          return s;
        });
        return changed ? { spaces: next } : spacesState;
      });
    });
  }, [spacesHydrated]);

  // Ensure the plugin snapshot is loaded before dispatching events.
  useEffect(() => {
    if (!spacesHydrated) return;
    void usePluginStore.getState().load();
  }, [spacesHydrated]);

  // Fire `spaces.loaded` once after hydration with the space list.
  useEffect(() => {
    if (!spacesHydrated || loadedOnce.current) return;
    loadedOnce.current = true;
    void usePluginStore
      .getState()
      .dispatchEvent(
        makeEvent("spaces.loaded", { spaces: spaces.filter((s) => s.root) }),
      );
  }, [spacesHydrated, spaces]);

  // Fire `space.activated` when the active space changes (guarded idempotent).
  useEffect(() => {
    if (!spacesHydrated) return;
    const id = activeSpaceId;
    if (!id || lastActiveSpaceId.current === id) return;
    lastActiveSpaceId.current = id;
    const space = spaces.find((s) => s.id === id);
    if (!space) return;
    void usePluginStore
      .getState()
      .dispatchEvent(
        makeEvent("space.activated", {
          space: { id: space.id, name: space.name, root: space.root },
        }),
      );
  }, [spacesHydrated, activeSpaceId, spaces]);
}
