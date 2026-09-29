/**
 * File status → Tailwind token mappings for the source-control panel.
 *
 * Kept in a pure, component-free module so they are unit-testable and don't
 * break React Fast Refresh (exporting functions from a component file trips
 * `react-refresh/only-export-components`).
 */

/** File status → text-color token (theme-aware semantic color). */
export function statusColor(code: string): string {
  switch (code) {
    case "A":
    case "U":
      return "text-added";
    case "M":
    case "R":
      return "text-modified";
    case "D":
      return "text-deleted";
    default:
      return "text-muted-foreground";
  }
}

/** File status → accent-bar background token on the row's leading edge. */
export function statusAccent(code: string): string {
  switch (code) {
    case "A":
    case "U":
      return "bg-added";
    case "M":
    case "R":
      return "bg-modified";
    case "D":
      return "bg-deleted";
    default:
      return "bg-muted-foreground/40";
  }
}
