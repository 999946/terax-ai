import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "@/lib/utils"
import {
  PANEL_RESIZE_BAR_CLASS,
  PANEL_RESIZE_KNOB_CLASS,
} from "./panel-resize-handle"

const DEFAULT_RESIZE_TARGET_MINIMUM_SIZE = {
  coarse: 24,
  fine: 12,
} as const

function ResizablePanelGroup({
  className,
  resizeTargetMinimumSize = DEFAULT_RESIZE_TARGET_MINIMUM_SIZE,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      resizeTargetMinimumSize={resizeTargetMinimumSize}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        PANEL_RESIZE_BAR_CLASS,
        "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-3 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && <div className={PANEL_RESIZE_KNOB_CLASS} />}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
