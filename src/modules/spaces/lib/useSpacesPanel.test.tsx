// @vitest-environment happy-dom
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from "react";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpacesPanel } from "./useSpacesPanel";

/**
 * Regression: unpinning had to be visible to scheduleCollapse immediately.
 * togglePinned used a functional setState whose update landed on the *next*
 * render; a pointer-leave fired right after the click read the stale ref,
 * saw "pinned", and skipped the auto-collapse — so unpinning a panel stopped
 * it from ever collapsing. The hook now syncs pinnedRef in togglePinned.
 */

const PINNED_KEY = "terax.spaces.pinned";

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let api: ReturnType<typeof useSpacesPanel> | null = null;

function probe() {
  function Probe() {
    api = useSpacesPanel();
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<Probe />);
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  api = null;
  host?.remove();
  host = null;
});

describe("useSpacesPanel auto-collapse", () => {
  it("collapses when unpinned and the pointer leaves the panel", () => {
    // Start pinned.
    localStorage.setItem(PINNED_KEY, "true");
    probe();
    expect(api!.pinned).toBe(true);

    // Unpin (this is the failing path: ref must flip synchronously).
    act(() => api!.togglePinned());
    expect(api!.pinned).toBe(false);

    // Pointer leaves: scheduleCollapse must schedule (not no-op). Fake timers
    // are armed first so the collapse timer is owned by the fake clock.
    vi.useFakeTimers();
    act(() => api!.scheduleCollapse());
    expect(api!.collapsed).toBe(false);

    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(api!.collapsed).toBe(true);
    vi.useRealTimers();
  });

  it("keeps a pinned panel expanded on pointer leave", () => {
    localStorage.setItem(PINNED_KEY, "true");
    probe();
    expect(api!.pinned).toBe(true);

    act(() => api!.scheduleCollapse());
    // No timer should fire for a pinned panel.
    vi.useFakeTimers();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(api!.collapsed).toBe(false);
    vi.useRealTimers();
  });
});
