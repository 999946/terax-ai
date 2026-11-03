export type LspNavigator = {
  /** `line` is 1-based; `character` is the 0-based column on that line. */
  openFile: (path: string, line: number, character?: number) => void;
};

let current: LspNavigator | null = null;

export function setLspNavigator(nav: LspNavigator | null): void {
  current = nav;
}

export function getLspNavigator(): LspNavigator | null {
  return current;
}
