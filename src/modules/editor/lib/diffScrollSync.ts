/**
 * IDEA's side-by-side diff without alignment padding: each pane scrolls on its
 * own and scrolling one carries the other along through the changes
 * (IntelliJ's SyncScrollSupport). This is a port of OpenIDEA's
 * `diffScroll.ts`:
 *
 * - the pane the user is not touching is anchored a third down the viewport,
 * - unchanged stretches map proportionally, changed stretches map line by line
 *   and wait at the end of the shorter side,
 * - the pane that was moved programmatically reports the echo, so it does not
 *   start a feedback loop.
 */
import { type Chunk } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";

type Side = "a" | "b";

/** A stretch of both documents in pixels: unchanged text, or a change. */
type Band = {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
  changed: boolean;
};

/** The two panes plus the chunks they share. */
export type MergePanes = {
  a: EditorView;
  b: EditorView;
  chunks: () => readonly Chunk[];
};

/** Pixel [top, bottom] of a chunk range in `view`; an empty range is a boundary. */
function extent(view: EditorView, from: number, to: number): [number, number] {
  const max = view.state.doc.length;
  if (from > max) {
    const end = view.lineBlockAt(max).bottom;
    return [end, end];
  }
  const top = view.lineBlockAt(from).top;
  return from >= to
    ? [top, top]
    : [top, view.lineBlockAt(Math.min(to - 1, max)).bottom];
}

/** First index in `[0, n)` where `past` holds, assuming it holds from some point on. */
function firstIndex(n: number, past: (index: number) => boolean): number {
  let low = 0;
  let high = n;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (past(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * The stretch of both documents around pixel `y` of side `from` (IDEA's
 * BaseSyncScrollable.processHelper). Only the chunks next to `y` are measured.
 */
function bandAt(
  chunks: readonly Chunk[],
  extentA: (chunk: Chunk) => [number, number],
  extentB: (chunk: Chunk) => [number, number],
  endA: number,
  endB: number,
  y: number,
  from: Side,
): Band {
  const master = from === "a" ? extentA : extentB;
  const next = firstIndex(
    chunks.length,
    (index) => master(chunks[index])[0] > y,
  );
  let a = 0;
  let b = 0;
  const previous = chunks[next - 1];
  if (previous) {
    const [a0, a1] = extentA(previous);
    const [b0, b1] = extentB(previous);
    if (y < (from === "a" ? a1 : b1)) {
      return { a0, a1, b0, b1, changed: true };
    }
    a = a1;
    b = b1;
  }
  const chunk = chunks[next];
  return chunk
    ? {
        a0: a,
        a1: extentA(chunk)[0],
        b0: b,
        b1: extentB(chunk)[0],
        changed: false,
      }
    : { a0: a, a1: endA, b0: b, b1: endB, changed: false };
}

/**
 * The position on the other side matching `y` (BaseSyncScrollable.transferLine,
 * in pixels): unchanged text maps proportionally, and inside a change the other
 * side follows line by line, then waits at the end of its shorter part.
 */
function transferY(bands: readonly Band[], y: number, from: Side): number {
  const fromA = from === "a";
  const band =
    bands.find((candidate) => y < (fromA ? candidate.a1 : candidate.b1)) ??
    bands[bands.length - 1];
  if (!band) return y;
  const [masterStart, masterEnd, slaveStart, slaveEnd] = fromA
    ? [band.a0, band.a1, band.b0, band.b1]
    : [band.b0, band.b1, band.a0, band.a1];
  if (band.changed) {
    return Math.min(slaveStart + (y - masterStart), slaveEnd);
  }
  return masterEnd > masterStart
    ? slaveStart +
        ((y - masterStart) * (slaveEnd - slaveStart)) /
          (masterEnd - masterStart)
    : slaveStart;
}

/** Offset of the document's top within the pane's scrolled content. */
function docOffset(view: EditorView): number {
  return (
    view.documentTop -
    view.scrollDOM.getBoundingClientRect().top +
    view.scrollDOM.scrollTop
  );
}

/**
 * Keeps two panes' scroll positions in step. `setEnabled(false)` stops
 * following without tearing the listeners down.
 */
export class SyncedPanes {
  private enabled: boolean;
  private frame = -1;
  /** The scroll position each pane was last moved to by the other one, so its
   * echo can be told from a user scroll. */
  private readonly moved: Record<
    Side,
    { top: number | null; left: number | null }
  > = {
    a: { top: null, left: null },
    b: { top: null, left: null },
  };
  private readonly listeners: Array<() => void> = [];

  constructor(
    private readonly panes: MergePanes,
    enabled = true,
  ) {
    this.enabled = enabled;
    for (const side of ["a", "b"] as const) {
      const element = this.view(side).scrollDOM;
      const onScroll = () => this.scrolled(side);
      element.addEventListener("scroll", onScroll, { passive: true });
      this.listeners.push(() =>
        element.removeEventListener("scroll", onScroll),
      );
    }
    window.addEventListener("resize", this.schedule);
    this.listeners.push(() =>
      window.removeEventListener("resize", this.schedule),
    );
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) this.followFrom("b");
  }

  destroy(): void {
    if (this.frame >= 0) cancelAnimationFrame(this.frame);
    this.frame = -1;
    for (const remove of this.listeners) remove();
    this.listeners.length = 0;
  }

  private view(side: Side): EditorView {
    return side === "a" ? this.panes.a : this.panes.b;
  }

  private readonly schedule = (): void => {
    if (this.frame >= 0 || !this.enabled) return;
    this.frame = requestAnimationFrame(() => this.followFrom("b"));
  };

  private scrolled(side: Side): void {
    const element = this.view(side).scrollDOM;
    const moved = this.moved[side];
    const echo =
      (moved.top !== null || moved.left !== null) &&
      (moved.top === null || Math.abs(element.scrollTop - moved.top) <= 1) &&
      (moved.left === null || Math.abs(element.scrollLeft - moved.left) <= 1);
    moved.top = null;
    moved.left = null;
    if (!echo && this.enabled) this.followFrom(side);
  }

  /** Scrolls the other pane to match `from`, anchored a third down the viewport. */
  private followFrom(from: Side): void {
    this.frame = -1;
    const to: Side = from === "a" ? "b" : "a";
    const master = this.view(from);
    const slave = this.view(to);
    const anchor = master.scrollDOM.clientHeight / 3;
    const at = master.scrollDOM.scrollTop + anchor - docOffset(master);
    const { a, b } = this.panes;
    const chord = bandAt(
      this.panes.chunks(),
      (chunk) => extent(a, chunk.fromA, chunk.toA),
      (chunk) => extent(b, chunk.fromB, chunk.toB),
      a.lineBlockAt(a.state.doc.length).bottom,
      b.lineBlockAt(b.state.doc.length).bottom,
      Math.max(0, at),
      from,
    );
    const target = transferY([chord], Math.max(0, at), from);
    const element = slave.scrollDOM;
    const top = Math.max(
      0,
      Math.min(
        target + docOffset(slave) - anchor,
        element.scrollHeight - element.clientHeight,
      ),
    );
    if (Math.abs(element.scrollTop - top) >= 1) {
      const before = element.scrollTop;
      element.scrollTop = top;
      if (element.scrollTop !== before) this.moved[to].top = element.scrollTop;
    }
    const left = master.scrollDOM.scrollLeft;
    if (Math.abs(element.scrollLeft - left) >= 1) {
      const before = element.scrollLeft;
      element.scrollLeft = left;
      if (element.scrollLeft !== before)
        this.moved[to].left = element.scrollLeft;
    }
  }
}
