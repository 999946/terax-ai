import { cn } from "@/lib/utils";
import { SettingsApp } from "@/settings/SettingsApp";
import { useFloatingSettings } from "./floatingSettingsStore";

/**
 * Global, space-independent settings overlay. Mounted alongside WorkspaceSurface
 * and kept mounted (visibility toggled), so the active section and form state
 * survive close/reopen. Never touches activeId, so closing just reveals the
 * previously active tab. z-50 clears the stacked tab surfaces above.
 */
export function FloatingSettingsOverlay() {
  const open = useFloatingSettings((s) => s.open);
  return (
    <div
      className={cn(
        "absolute inset-0 z-50",
        !open && "invisible pointer-events-none",
      )}
      aria-hidden={!open}
    >
      <SettingsApp />
    </div>
  );
}