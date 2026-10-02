import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

export type ContentHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

type GrepResponse = {
  hits: ContentHit[];
  truncated: boolean;
  files_scanned: number;
};

export type ReplaceResponse = {
  files_changed: number;
  replacements: number;
};

/** Escape regex metacharacters so a literal query can be matched literally. */
const RE_META = /[.+*?()|[\]{}^$\\]/g;
export function escapeLiteral(s: string): string {
  return s.replace(RE_META, "\\$&");
}

/**
 * Preview search over the workspace root. Mirrors the backend: `fs_grep` treats
 * the pattern as a regex, so literal mode escapes it first; `case_insensitive`
 * is inverted against the UI's `matchCase` flag.
 */
export async function searchInFiles(params: {
  root: string;
  query: string;
  regex: boolean;
  matchCase: boolean;
  maxResults?: number;
}): Promise<ContentHit[]> {
  const pattern = params.regex ? params.query : escapeLiteral(params.query);
  const res = await invoke<GrepResponse>("fs_grep", {
    pattern,
    root: params.root,
    case_insensitive: !params.matchCase,
    max_results: params.maxResults ?? 200,
    workspace: currentWorkspaceEnv(),
  });
  return res.hits;
}

/**
 * Batch-replace across the workspace root. `literal` and `case_insensitive`
 * map to the backend flags (see `fs_replace_matches`); the backend re-walks the
 * tree atomically with its own EOL preservation and replacement ceiling, so the
 * preview above is only a hint.
 */
export async function replaceInFiles(params: {
  root: string;
  query: string;
  replacement: string;
  regex: boolean;
  matchCase: boolean;
}): Promise<ReplaceResponse> {
  return invoke<ReplaceResponse>("fs_replace_matches", {
    pattern: params.query,
    replacement: params.replacement,
    root: params.root,
    literal: !params.regex,
    case_insensitive: !params.matchCase,
    workspace: currentWorkspaceEnv(),
  });
}
