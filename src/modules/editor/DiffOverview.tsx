import { cn } from "@/lib/utils";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import type { RulerMark } from "./lib/diffHunkMarkers";

type Props = {
  /** Total modified-file (B) line count, the coordinate space of `marks`. */
  totalLines: number;
  /** Contiguous changed bands to render, already clamped to the doc. */
  marks: RulerMark[];
  /** Scroll the diff view to a target B-side line. */
  onJump: (line: number) => void;
};

const MIN_BAND_PERCENT = 0.4;

/** The band whose span sits closest to `line`; its center is the jump target.
 * Empty marks resolve to `null` (nothing to jump to). */
function nearestMarkCenter(marks: RulerMark[], line: number): number | null {
  if (marks.length === 0 || line < 1) return null;
  let best = marks[0];
  let bestDist = Infinity;
  for (const m of marks) {
    const dist = line < m.from ? m.from - line : line > m.to ? line - m.to : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
  }
  return Math.round((best.from + best.to) / 2);
}

/**
 * A thin right-edge ruler of the git diff pane (VS Code overview style):
 * changed lines are folded into contiguous green/red bands positioned by
 * logical line ratio, so a glance shows where the file differs. Clicking a
 * band scrolls the active diff view to that change.
 */
export function DiffOverview({ totalLines, marks, onJump }: Props) {
  const { t } = useTranslation();

  if (totalLines < 1 || marks.length === 0) return null;

  const handleMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = (e.clientY - rect.top) / rect.height;
    const line = Math.max(
      1,
      Math.min(totalLines, Math.round(ratio * totalLines)),
    );
    const target = nearestMarkCenter(marks, line);
    if (target !== null) onJump(target);
  };

  return (
    <div
      role="img"
      aria-label={t("editor.diffOverview")}
      className="absolute bottom-0 right-1 top-0 z-20 w-[6px] cursor-pointer"
      onMouseDown={handleMouseDown}
    >
      {marks.map((m, i) => {
        const top = ((m.from - 1) / totalLines) * 100;
        const height = Math.max(
          ((m.to - m.from + 1) / totalLines) * 100,
          MIN_BAND_PERCENT,
        );
        return (
          <div
            key={i}
            className={cn(
              "absolute w-full",
              m.kind === "add"
                ? "bg-[var(--ml-added)]"
                : "bg-[var(--ml-deleted)]",
            )}
            style={{ top: `${top}%`, height: `${height}%` }}
          />
        );
      })}
    </div>
  );
}
