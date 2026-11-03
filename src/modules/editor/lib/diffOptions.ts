/**
 * Diff viewer settings, mirroring IDEA's diff toolbar (and OpenIDEA's
 * `diffOptions.ts`): viewer kind, whitespace policy, highlighting, collapsed
 * unchanged fragments, synchronized scrolling and change alignment.
 */
export type DiffViewerMode = "split" | "inline";
export type DiffIgnorePolicy =
  | "none"
  | "trim"
  | "whitespace"
  | "whitespaceAndLines";
export type DiffHighlightPolicy = "words" | "lines" | "none";

export type DiffViewerOptions = {
  mode: DiffViewerMode;
  ignore: DiffIgnorePolicy;
  highlight: DiffHighlightPolicy;
  collapse: boolean;
  /** Side-by-side panes scroll together. */
  syncScroll: boolean;
  /** Side-by-side panes are padded so unchanged lines line up. */
  alignChanges: boolean;
};

export const IGNORE_OPTIONS: ReadonlyArray<{
  value: DiffIgnorePolicy;
  labelKey: string;
}> = [
  { value: "none", labelKey: "editor.diffIgnoreNone" },
  { value: "trim", labelKey: "editor.diffIgnoreTrim" },
  { value: "whitespace", labelKey: "editor.diffIgnoreWhitespaces" },
  {
    value: "whitespaceAndLines",
    labelKey: "editor.diffIgnoreWhitespacesAndLines",
  },
];

export const HIGHLIGHT_OPTIONS: ReadonlyArray<{
  value: DiffHighlightPolicy;
  labelKey: string;
}> = [
  { value: "words", labelKey: "editor.diffHighlightWords" },
  { value: "lines", labelKey: "editor.diffHighlightLines" },
  { value: "none", labelKey: "editor.diffHighlightNone" },
];

export const DEFAULT_DIFF_VIEWER_OPTIONS: DiffViewerOptions = {
  mode: "split",
  ignore: "none",
  highlight: "words",
  // Matches the editor preference's default; the two are kept in step so the
  // Settings switch and the toolbar toggle always agree.
  collapse: false,
  syncScroll: true,
  alignChanges: false,
};

const STORAGE_KEY = "terax:diff-options";

function oneOf<T extends string>(
  value: unknown,
  options: ReadonlyArray<{ value: T }>,
  fallback: T,
): T {
  return options.some((option) => option.value === value)
    ? (value as T)
    : fallback;
}

/** Parses stored options, falling back per field so a partial value is safe. */
export function parseDiffViewerOptions(raw: unknown): DiffViewerOptions {
  const input =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const fallback = DEFAULT_DIFF_VIEWER_OPTIONS;
  const bool = (key: keyof DiffViewerOptions, value: unknown): boolean =>
    typeof value === "boolean" ? value : (fallback[key] as boolean);
  return {
    mode: input.mode === "inline" ? "inline" : "split",
    ignore: oneOf(input.ignore, IGNORE_OPTIONS, fallback.ignore),
    highlight: oneOf(input.highlight, HIGHLIGHT_OPTIONS, fallback.highlight),
    collapse: bool("collapse", input.collapse),
    syncScroll: bool("syncScroll", input.syncScroll),
    alignChanges: bool("alignChanges", input.alignChanges),
  };
}

/** The stored options, or null when this viewer has never been configured. */
export function readDiffViewerOptions(): DiffViewerOptions | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseDiffViewerOptions(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function loadDiffViewerOptions(): DiffViewerOptions {
  return readDiffViewerOptions() ?? DEFAULT_DIFF_VIEWER_OPTIONS;
}

export function saveDiffViewerOptions(options: DiffViewerOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // Storage may be unavailable (private mode / quota); defaults still apply.
  }
}

/** Whether the whitespace policy asks for an engine override at all. */
export function ignoresWhitespace(policy: DiffIgnorePolicy): boolean {
  return policy !== "none";
}

/** Whether the highlight policy asks for inner word fragments. */
export function highlightsWords(policy: DiffHighlightPolicy): boolean {
  return policy === "words";
}

/** Whether changed lines get any background at all. */
export function highlightsLines(policy: DiffHighlightPolicy): boolean {
  return policy !== "none";
}
