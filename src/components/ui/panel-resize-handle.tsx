import { useState } from "react";
import { cn } from "@/lib/utils";

// Shared handle visual, single source of truth: resizable.tsx's ResizableHandle
// (inside a PanelGroup) and PanelResizeHandle (standalone) both consume these.
// The bar's hover/active highlight keys off `data-separator`, which the
// library sets itself inside a PanelGroup and this component sets manually.
export const PANEL_RESIZE_BAR_CLASS =
  "relative z-20 flex w-px select-none items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2 data-[separator=active]:bg-ring/70 data-[separator=hover]:bg-ring/40 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden";
export const PANEL_RESIZE_KNOB_CLASS =
  "z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border";

type ResizeState = null | "hover" | "active";

type Props = {
  /** Current panel width (controlled). */
  value: number;
  /** Called with the next width while dragging. */
  onChange: (next: number) => void;
  ariaLabel?: string;
  /** Fired when a drag begins — lets a caller keep a hover-collapsible panel open. */
  onResizeStart?: () => void;
  className?: string;
};

/**
 * A PanelGroup-independent resize handle. Matches react-resizable-panels'
 * ResizableHandle look & feel (hover `bg-ring/40`, dragging `bg-ring/70`,
 * always-visible knob) but implements its own pointer drag, so it can be used
 * outside a PanelGroup (e.g. the spaces panel's standalone width drag).
 */
export function PanelResizeHandle({
  value,
  onChange,
  ariaLabel,
  onResizeStart,
  className,
}: Props) {
  const [state, setState] = useState<ResizeState>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = value;
    setState("active");
    onResizeStart?.();
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (ev: PointerEvent) => onChange(startWidth + (ev.clientX - startX));
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setState(null);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      tabIndex={0}
      data-separator={state}
      onPointerDown={handlePointerDown}
      onPointerEnter={() => setState("active" === state ? "active" : "hover")}
      onPointerLeave={() => setState(null)}
      className={cn(PANEL_RESIZE_BAR_CLASS, className)}
    >
      <div className={PANEL_RESIZE_KNOB_CLASS} />
    </div>
  );
}
