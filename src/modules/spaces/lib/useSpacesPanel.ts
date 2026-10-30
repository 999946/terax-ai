import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "terax.spaces.collapsed";
const PINNED_KEY = "terax.spaces.pinned";
const WIDTH_KEY = "terax.spaces.width";
export const SPACES_PANEL_WIDTH = 260;
export const SPACES_PANEL_MIN_WIDTH = 180;
export const SPACES_PANEL_MAX_WIDTH = 560;
export const SPACES_PANEL_COLLAPSED_WIDTH = 42;
const CLOSE_DELAY_MS = 180;

function readBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    if (!Number.isFinite(n) || n <= 0) return SPACES_PANEL_WIDTH;
    return Math.min(
      SPACES_PANEL_MAX_WIDTH,
      Math.max(SPACES_PANEL_MIN_WIDTH, Math.round(n)),
    );
  } catch {
    return SPACES_PANEL_WIDTH;
  }
}

export function useSpacesPanel() {
  const [collapsed, setCollapsed] = useState(() => readBool(STORAGE_KEY));
  const [pinned, setPinned] = useState(() => readBool(PINNED_KEY));
  const [width, setWidthState] = useState(readWidth);
  const timerRef = useRef<number | null>(null);
  // Mirror pinned so scheduleCollapse's callback closure never goes stale.
  // Updated both at render time and synchronously in togglePinned, so a click
  // followed by an immediate pointer-leave still sees the new value (React
  // state is async — waiting for the next render would drop the collapse).
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;

  const persist = useCallback((value: boolean) => {
    setCollapsed(value);
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // Storage is optional; panel behavior still works without it.
    }
  }, []);

  const setWidth = useCallback((next: number) => {
    const clamped = Math.min(
      SPACES_PANEL_MAX_WIDTH,
      Math.max(SPACES_PANEL_MIN_WIDTH, Math.round(next)),
    );
    setWidthState(clamped);
    try {
      localStorage.setItem(WIDTH_KEY, String(clamped));
    } catch {
      // Storage is optional; the drag still works within the session.
    }
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const scheduleCollapse = useCallback(() => {
    // A pinned panel stays expanded and is never auto-collapsed.
    if (pinnedRef.current) {
      clearTimer();
      return;
    }
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      persist(true);
    }, CLOSE_DELAY_MS);
  }, [clearTimer, persist]);

  const expand = useCallback(() => {
    clearTimer();
    persist(false);
  }, [clearTimer, persist]);

  const collapse = useCallback(() => persist(true), [persist]);

  const togglePinned = useCallback(() => {
    const next = !pinnedRef.current;
    // Sync the ref immediately so a pointer-leave that fires right after the
    // click (before React's async render) still sees the unpinned value and
    // schedules the auto-collapse. Waiting for the next render would drop it.
    pinnedRef.current = next;
    setPinned(next);
    try {
      localStorage.setItem(PINNED_KEY, String(next));
    } catch {
      // Storage is optional; pinning still works within the session.
    }
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return {
    collapsed,
    expand,
    collapse,
    scheduleCollapse,
    pinned,
    togglePinned,
    width,
    setWidth,
  };
}
