import { create } from "zustand";

/**
 * The settings panel is a global, space-independent overlay rendered above the
 * workspace surface. Unlike the per-space tab system it is driven by its own
 * store: switching Spaces writes only useSpaces/activeId, so this state survives
 * cross-Space (and the panel never counts as a tab in any Space). Not persisted;
 * closed on cold boot.
 */
export type SettingsTab =
  | "general"
  | "editor"
  | "themes"
  | "shortcuts"
  | "models"
  | "agents"
  | "plugin"
  | "about";

type State = {
  open: boolean;
  /** Last active section — survives close and Space switches. */
  section: SettingsTab;
  /** Open (or switch to) the panel. No arg keeps the last section. */
  openSettings: (section?: SettingsTab) => void;
  closeSettings: () => void;
  setSection: (section: SettingsTab) => void;
};

export const useFloatingSettings = create<State>((set) => ({
  open: false,
  section: "general",
  openSettings: (section) =>
    set((s) => ({ open: true, section: section ?? s.section })),
  closeSettings: () => set({ open: false }),
  setSection: (section) => set({ section }),
}));
