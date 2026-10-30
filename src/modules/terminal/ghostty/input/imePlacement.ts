import type { TerminalCursor } from "@/modules/terminal/backend/contracts";

export type ImePlacement = {
  readonly leftPx: number;
  readonly topPx: number;
};

/**
 * Compute the pixel position where the hidden terminal input textarea should
 * sit, given the current cursor cell and cell dimensions. The OS IME candidate
 * window (Chinese / Japanese / Korean input) anchors to that textarea's rect,
 * so parking it on the cursor's cell makes the candidate box follow the caret;
 * without this both renderers leave the textarea at (0,0) and candidates stay
 * pinned to the surface's top-left corner.
 *
 * The cursor is clamped into the viewport so a scrolled-out caret cannot push
 * the textarea (or the candidate window) off the visible surface.
 */
export function imePlacementForCell(
  cursor: TerminalCursor,
  opts: {
    readonly cols: number;
    readonly rows: number;
    readonly cellWidthPx: number;
    readonly cellHeightPx: number;
  },
): ImePlacement {
  const cell = opts.cellWidthPx > 0 ? opts.cellWidthPx : 8;
  const line = opts.cellHeightPx > 0 ? opts.cellHeightPx : 16;
  const x = Math.max(0, Math.min(cursor.x, opts.cols - 1));
  const y = Math.max(0, Math.min(cursor.y, opts.rows - 1));
  return { leftPx: Math.round(x * cell), topPx: Math.round(y * line) };
}
