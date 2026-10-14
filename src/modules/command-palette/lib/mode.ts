import type { PaletteMode } from "../types";

export type ParsedQuery = {
  mode: PaletteMode;
  term: string;
  raw: string;
};

// No-prefix input is the VSCode-style Quick Open: file name search. `>`
// switches to command search (what Cmd+Shift+P prefills); `!` to shell
// command history; `#` to file-content search; `?` lists these modes.
const PREFIXES: ReadonlyArray<{ sigil: string; mode: PaletteMode }> = [
  { sigil: ">", mode: "commands" },
  { sigil: "!", mode: "history" },
  { sigil: "#", mode: "content" },
  { sigil: "?", mode: "help" },
];

export function parseQuery(raw: string): ParsedQuery {
  for (const { sigil, mode } of PREFIXES) {
    if (raw.startsWith(sigil)) {
      return { mode, term: raw.slice(sigil.length).trim(), raw };
    }
  }
  return { mode: "files", term: raw.trim(), raw };
}

export const MODE_HINTS: ReadonlyArray<{ sigil: string; labelKey: string }> = [
  { sigil: ">", labelKey: "commandPalette.hint.commands" },
  { sigil: "#", labelKey: "commandPalette.hint.content" },
  { sigil: "!", labelKey: "commandPalette.hint.history" },
];
