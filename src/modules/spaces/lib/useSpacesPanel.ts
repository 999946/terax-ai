import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "terax.spaces.collapsed";
const PINNED_KEY = "terax.spaces.pinned";
export const SPACES_PANEL_WIDTH = 260;
export const SPACES_PANEL_COLLAPSED_WIDTH = 42;
const CLOSE_DELAY_MS = 180;

function readBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

export function useSpacesPanel() {
  const [collapsed, setCollapsed] = useState(() => readBool(STORAGE_KEY));
  const [pinned, setPinned] = useState(() => readBool(PINNED_KEY));
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

  return { collapsed, expand, collapse, scheduleCollapse, pinned, togglePinned };
}
