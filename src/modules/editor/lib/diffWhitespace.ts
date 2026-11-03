/**
 * Whitespace-aware diff for the viewer toolbar's "Ignore whitespaces" /
 * "Trim whitespaces" policies. `@codemirror/merge` has no built-in whitespace
 * handling, so — like OpenIDEA's `ideaDiffConfig` — a custom `diffConfig` is
 * provided via `override`. Instead of porting IntelliJ's full comparison
 * engine, both documents are *projected* under the policy (a canonical text
 * where the ignored whitespace and empty lines are gone) and the engine's own
 * `diff` runs on the projections, mapping every change back onto the real
 * offsets.
 */
import { Change, diff, type DiffConfig } from "@codemirror/merge";
import {
  type DiffHighlightPolicy,
  type DiffIgnorePolicy,
  highlightsWords,
  ignoresWhitespace,
} from "./diffOptions";

const WHITESPACE = /\s/g;

/**
 * A projected side of the comparison: `text` is the canonical form under the
 * policy and `offsetOf[i]` maps projected index `i` to its real offset (final
 * index maps to the real length). Insertions/deletions of ignored whitespace
 * (and, under `whitespaceAndLines`, whole empty lines) disappear from the
 * projection, so the engine reports no change for them — which is the point of
 * each policy.
 */
type Projection = {
  text: string;
  offsetOf: number[];
};

/** Whether `policy` requires overriding the engine's default comparison. */
export function needsWhitespaceOverride(policy: DiffIgnorePolicy): boolean {
  return ignoresWhitespace(policy);
}

function project(text: string, policy: DiffIgnorePolicy): Projection {
  const dropEmptyLines = policy === "whitespaceAndLines";
  const offsetOf = [0];
  let out = "";
  let at = 0;
  let lineStart = 0;
  while (at <= text.length) {
    const nl = text.indexOf("\n", at);
    const hasNl = nl !== -1;
    const lineEnd = hasNl ? nl : text.length;
    const raw = text.slice(lineStart, lineEnd);
    let slice = raw;
    if (policy === "trim" || dropEmptyLines) {
      slice = raw.trim();
    } else if (policy === "whitespace") {
      slice = raw.replace(WHITESPACE, "");
    }
    if (!(dropEmptyLines && slice === "")) {
      const sliceStart =
        policy === "trim" || dropEmptyLines
          ? lineStart + raw.indexOf(slice)
          : lineStart;
      for (let i = 0; i < slice.length; i++) {
        out += slice[i];
        offsetOf.push(sliceStart + i + 1);
      }
      if (hasNl) {
        out += "\n";
        offsetOf.push(nl + 1);
      }
    }
    lineStart = nl + 1;
    at = nl + 1;
    if (!hasNl) break;
  }
  // The projection always ends where the real text does (even an ignored last line).
  offsetOf[offsetOf.length - 1] = text.length;
  return { text: out, offsetOf };
}

/**
 * A `DiffConfig.override` that ignores whitespace per `policy`. When `policy`
 * is `"none"` the caller should simply omit the override entirely.
 */
export function whitespaceOverride(
  policy: DiffIgnorePolicy,
): (a: string, b: string) => readonly Change[] {
  return (a, b) => {
    const pa = project(a, policy);
    const pb = project(b, policy);
    return diff(pa.text, pb.text).map((change) => {
      const fromA = pa.offsetOf[clampIndex(change.fromA, pa.offsetOf.length)];
      const toA = pa.offsetOf[clampIndex(change.toA, pa.offsetOf.length)];
      const fromB = pb.offsetOf[clampIndex(change.fromB, pb.offsetOf.length)];
      const toB = pb.offsetOf[clampIndex(change.toB, pb.offsetOf.length)];
      return new Change(fromA, toA, fromB, toB);
    });
  };
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length - 1));
}

/** The `DiffConfig` to pass to a MergeView / unifiedMergeView. */
export function diffConfigFor(policy: DiffIgnorePolicy): DiffConfig {
  if (!needsWhitespaceOverride(policy)) return {};
  return { override: whitespaceOverride(policy) };
}

/**
 * IDEA's word-level highlighting: when "Highlight words" is on, a merge view
 * with `highlightChanges: false` still highlights the inner fragments of each
 * chunk, in the chunk's own type. The engine's `changedText` marks are colour
 * themed in `GitDiffPane.DIFF_THEME`; setting `highlightChanges` false leaves
 * the whole-line painting to `ideaDiffPane`.
 */
export function highlightChangesFor(policy: DiffHighlightPolicy): {
  highlightChanges: boolean;
  words: boolean;
} {
  return {
    highlightChanges: highlightsWords(policy),
    words: highlightsWords(policy),
  };
}
