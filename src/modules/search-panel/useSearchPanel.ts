import { create } from "zustand";

/**
 * Bottom-docked cross-file find & replace panel (WebStorm interaction).
 * Kept as a tiny zustand store so the command palette, keyboard shortcuts and
 * the App overlay can all toggle it without prop drilling — mirrors the
 * `panelOpen` pattern in `chatStore`.
 */
type SearchPanelState = {
  open: boolean;
  replaceMode: boolean;
  query: string;
  replacement: string;
  matchCase: boolean;
  regex: boolean;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  setReplaceMode: (v: boolean) => void;
  setQuery: (q: string) => void;
  setReplacement: (r: string) => void;
  setMatchCase: (v: boolean) => void;
  setRegex: (v: boolean) => void;
};

export const useSearchPanel = create<SearchPanelState>((set) => ({
  open: false,
  replaceMode: false,
  query: "",
  replacement: "",
  matchCase: false,
  regex: false,
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
  togglePanel: () => set((s) => ({ open: !s.open })),
  setReplaceMode: (v) => set({ replaceMode: v }),
  setQuery: (q) => set({ query: q }),
  setReplacement: (r) => set({ replacement: r }),
  setMatchCase: (v) => set({ matchCase: v }),
  setRegex: (v) => set({ regex: v }),
}));
