import { useEffect } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { listenFsChanged, watchAdd, watchRemove } from "@/modules/explorer/lib/watch";
import { listSpaceFolders } from "./filesystem";
import { useSpaces } from "./useSpaces";

export function useSpacesDirectorySync(): void {
  const root = usePreferencesStore((s) => s.spacesRoot);
  useEffect(() => {
    if (!root) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scan = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void listSpaceFolders(root).then((roots) => {
          if (alive) useSpaces.getState().reconcile(roots);
        }).catch(() => {});
      }, 100);
    };
    scan();
    watchAdd([root]);
    const unlisten = listenFsChanged((paths) => {
      if (paths.some((path) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))) scan();
    });
    const onFocus = () => scan();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      watchRemove([root]);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      void unlisten.then((fn) => fn());
    };
  }, [root]);
}
