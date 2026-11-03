/**
 * The rail between the two panes of an IDEA-style split diff: a curved
 * coloured band joins each change across the divider, with a midline showing
 * which row on the left matches which on the right (IntelliJ's
 * DiffDividerDrawUtil). Simplified from OpenIDEA's `diffScroll.ts`.
 */
import { type Chunk } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { chunkKind } from "./diffIdea";
import { type MergePanes } from "./diffScrollSync";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Pixel [top, bottom] of a chunk range in `view`; empty range is a boundary. */
export function extent(
  view: EditorView,
  from: number,
  to: number,
): [number, number] {
  const len = view.state.doc.length;
  if (from > len) {
    const end = view.lineBlockAt(len).bottom;
    return [end, end];
  }
  const top = view.lineBlockAt(from).top;
  return from >= to
    ? [top, top]
    : [top, view.lineBlockAt(Math.min(to - 1, len)).bottom];
}

/** The divider band path between [a0,a1] on the left and [b0,b1] on the right. */
export function bandPath(
  width: number,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
): string {
  if (a1 - a0 < 2) {
    a0 -= 1;
    a1 = a0 + 2;
  }
  if (b1 - b0 < 2) {
    b0 -= 1;
    b1 = b0 + 2;
  }
  const c1 = width * 0.3;
  const c2 = width * 0.7;
  return (
    `M0 ${a0}C${c1} ${a0} ${c2} ${b0} ${width} ${b0}` +
    `L${width} ${b1}C${c2} ${b1} ${c1} ${a1} 0 ${a1}Z`
  );
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

/** Draws the divider and keeps it in step with both panes' scroll positions. */
export class DiffDivider {
  private readonly divider: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly bandLayer: SVGGElement;
  private frame = -1;
  private resize: ResizeObserver | null = null;
  private readonly cleanup: Array<() => void> = [];

  constructor(private readonly panes: MergePanes) {
    this.divider = document.createElement("div");
    this.divider.className = "cm-diffDivider";
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.setAttribute("aria-hidden", "true");
    this.bandLayer = document.createElementNS(SVG_NS, "g");
    this.svg.appendChild(this.bandLayer);
    this.divider.appendChild(this.svg);

    for (const side of ["a", "b"] as const) {
      const element = this.panes[side].scrollDOM;
      const onScroll = () => this.schedule();
      element.addEventListener("scroll", onScroll, { passive: true });
      this.cleanup.push(() => element.removeEventListener("scroll", onScroll));
    }
    // The divider is as tall as the panes; the wheel over it scrolls them.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.panes.b.scrollDOM.scrollBy(e.deltaX, e.deltaY);
    };
    this.divider.addEventListener("wheel", onWheel, { passive: false });
    this.cleanup.push(() => this.divider.removeEventListener("wheel", onWheel));
    if (typeof ResizeObserver !== "undefined") {
      this.resize = new ResizeObserver(() => this.schedule());
      this.resize.observe(this.divider);
    }
    window.addEventListener("resize", this.schedule);
    this.cleanup.push(() =>
      window.removeEventListener("resize", this.schedule),
    );
    this.frame = requestAnimationFrame(this.draw);
  }

  /** The divider element, mounted between the panes. */
  get dom(): HTMLDivElement {
    return this.divider;
  }

  /** Mounts the rail between the two pane wrappers, as IDEA places it. */
  attach(mv: { a: EditorView }): void {
    const wrapper = mv.a.dom.parentElement;
    if (!wrapper) return;
    wrapper.after(this.divider);
    this.schedule();
  }

  destroy(): void {
    if (this.frame >= 0) cancelAnimationFrame(this.frame);
    this.frame = -1;
    this.resize?.disconnect();
    this.resize = null;
    for (const remove of this.cleanup) remove();
    this.cleanup.length = 0;
    this.divider.remove();
  }

  private readonly schedule = (): void => {
    if (this.frame >= 0) return;
    this.frame = requestAnimationFrame(this.draw);
  };

  private readonly draw = (): void => {
    this.frame = -1;
    const { a, b, chunks: readChunks } = this.panes;
    if (!a.dom.isConnected || !b.dom.isConnected) return;
    const rect = this.divider.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    if (!width || !height) return;
    this.svg.setAttribute("width", String(width));
    this.svg.setAttribute("height", String(height));
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const chunks = readChunks();
    const offsetA = a.documentTop - rect.top;
    const offsetB = b.documentTop - rect.top;
    // Chunks run down both panes in order: start at the first one still on screen.
    const first = Math.min(
      firstIndex(
        chunks.length,
        (i) => extent(a, chunks[i].fromA, chunks[i].toA)[1] + offsetA >= -1,
      ),
      firstIndex(
        chunks.length,
        (i) => extent(b, chunks[i].fromB, chunks[i].toB)[1] + offsetB >= -1,
      ),
    );
    const paths: string[] = [];
    for (let i = first; i < chunks.length; i++) {
      const chunk: Chunk = chunks[i];
      const [rawA0, rawA1] = extent(a, chunk.fromA, chunk.toA);
      const [rawB0, rawB1] = extent(b, chunk.fromB, chunk.toB);
      const a0 = rawA0 + offsetA;
      const a1 = rawA1 + offsetA;
      const b0 = rawB0 + offsetB;
      const b1 = rawB1 + offsetB;
      if (a0 > height + 1 && b0 > height + 1) break;
      if (a1 < -1 && b1 < -1) continue;
      const kind = chunkKind(chunk);
      const midA = (a0 + a1) / 2;
      const midB = (b0 + b1) / 2;
      paths.push(
        `<path class="cm-diffBand cm-diffBand-${kind}" ` +
          `d="${bandPath(width, a0, a1, b0, b1)}"/>`,
        `<path class="cm-diffBandLine cm-diffBand-${kind}" ` +
          `d="M0 ${midA}C${width * 0.3} ${midA} ${width * 0.7} ${midB} ${width} ${midB}"/>`,
      );
    }
    this.bandLayer.innerHTML = paths.join("");
  };
}
