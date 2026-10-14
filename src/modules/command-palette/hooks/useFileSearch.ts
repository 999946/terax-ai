import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import { fuzzyBest } from "../lib/fuzzy";
import { type AsyncQueryState, useAsyncQuery } from "./useAsyncQuery";

export const FILES_MIN_QUERY = 2;
const SEARCH_LIMIT = 200;
const DEBOUNCE_MS = 200;
// Rendering safety cap for the in-memory listing fallback (unvirtualized cmdk
// rows). Empty/short queries show the best-matching slice; typing narrows it.
const LIST_DISPLAY_LIMIT = 300;

type SearchHit = {
  path: string;
  rel: string;
  name: string;
  is_dir: boolean;
};

type SearchResult = {
  hits: SearchHit[];
  truncated: boolean;
};

type ListFilesResult = { files: string[]; truncated: boolean };

export type FileHit = {
  path: string;
  rel: string;
  name: string;
  isDir: boolean;
};

/**
 * Quick-open file search. With a real query (>= FILES_MIN_QUERY chars) the
 * backend runs gitignore-aware fuzzy search (`fs_search`). For empty/short
 * input we fall back to the full workspace listing (`fs_list_files`) and rank
 * in-memory with fuzzyBest, so the panel opens showing every file and typing
 * progressively narrows it — matching VSCode Quick Open behaviour.
 */
export function useFileSearch(
  root: string | null,
  query: string,
  enabled: boolean,
  showHidden: boolean,
): AsyncQueryState<FileHit> {
  const run = useCallback(
    async (q: string): Promise<FileHit[]> => {
      if (!root) return [];
      if (q.trim().length >= FILES_MIN_QUERY) {
        const res = await invoke<SearchResult>("fs_search", {
          root,
          query: q.trim(),
          limit: SEARCH_LIMIT,
          showHidden,
          workspace: currentWorkspaceEnv(),
        });
        return res.hits.map((h) => ({
          path: h.path,
          rel: h.rel,
          name: h.name,
          isDir: h.is_dir,
        }));
      }
      const list = await invoke<ListFilesResult>("fs_list_files", {
        root,
        workspace: currentWorkspaceEnv(),
      });
      // Sort by fuzzy match on the relative path; empty query keeps the
      // backend's alphabetical order. Never match directories' rel paths.
      const scored: { rel: string; s: number }[] = [];
      for (const rel of list.files) {
        const s = fuzzyBest(q.trim(), [rel]);
        if (s !== null) scored.push({ rel, s });
      }
      scored.sort((a, b) => b.s - a.s || a.rel.localeCompare(b.rel));
      const top = scored.slice(0, LIST_DISPLAY_LIMIT);
      return top.map(({ rel }) => ({
        path: `${root.replace(/[\\/]+$/, "")}/${rel}`,
        rel,
        name: rel.split(/[\\/]/).pop() ?? rel,
        isDir: false,
      }));
    },
    [root, showHidden],
  );

  return useAsyncQuery({
    enabled: enabled && !!root,
    term: query,
    minLength: 0,
    debounceMs: DEBOUNCE_MS,
    run,
  });
}
