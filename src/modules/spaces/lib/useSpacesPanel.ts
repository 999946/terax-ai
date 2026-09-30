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

  const togglePinned = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PINNED_KEY, String(next));
      } catch {
        // Storage is optional; pinning still works within the session.
      }
      return next;
    });
  }, []);

  const expand = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    persist(false);
  }, [persist]);

  const collapse = useCallback(() => persist(true), [persist]);

  const scheduleCollapse = useCallback(() => {
    // A pinned panel stays expanded and is never auto-collapsed.
    if (pinnedRef.current) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      collapse();
    }, CLOSE_DELAY_MS);
  }, [collapse]);

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
