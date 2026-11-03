import { usePreferencesStore } from "@/modules/settings/preferences";
import { matchBinding, SHORTCUTS, type ShortcutId } from "../shortcuts";

const BY_ID = new Map(SHORTCUTS.map((s) => [s.id, s]));

/**
 * Whether `e` activates `id`, honoring the user's overrides. Imperative readers
 * (an editor's keymap, a pane-scoped handler) use this instead of the global
 * `useGlobalShortcuts` dispatcher, which only fires app-wide actions.
 */
export function matchesShortcut(e: KeyboardEvent, id: ShortcutId): boolean {
  const user = usePreferencesStore.getState().shortcuts;
  const bindings = user[id] ?? BY_ID.get(id)?.defaultBindings ?? [];
  return bindings.some((b) => matchBinding(e, b, id));
}
