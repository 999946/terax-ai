import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "terax.spaces.collapsed";
export const SPACES_PANEL_WIDTH = 260;
export const SPACES_PANEL_COLLAPSED_WIDTH = 42;
const CLOSE_DELAY_MS = 180;

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function useSpacesPanel() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const timerRef = useRef<number | null>(null);

  const persist = useCallback((value: boolean) => {
    setCollapsed(value);
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // Storage is optional; panel behavior still works without it.
    }
  }, []);

  const expand = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    persist(false);
  }, [persist]);

  const collapse = useCallback(() => persist(true), [persist]);

  const scheduleCollapse = useCallback(() => {
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

  return { collapsed, expand, collapse, scheduleCollapse };
}
