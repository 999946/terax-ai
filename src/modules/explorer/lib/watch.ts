import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentWorkspaceEnv } from "@/modules/workspace";

const FS_CHANGED_EVENT = "fs:changed";

/** Tri-state change kind carried by every `fs:changed` event (see watch.rs). */
export type FsChangeKind = "added" | "updated" | "deleted";

export type FsChange = {
  path: string;
  kind: FsChangeKind;
};

export type FsChangedPayload = { changes: FsChange[] };

export function watchAdd(paths: string[]): void {
  if (paths.length === 0) return;
  void invoke("fs_watch_add", {
    paths,
    workspace: currentWorkspaceEnv(),
  }).catch(() => {});
}

export function watchRemove(paths: string[]): void {
  if (paths.length === 0) return;
  void invoke("fs_watch_remove", {
    paths,
    workspace: currentWorkspaceEnv(),
  }).catch(() => {});
}

export function watchGitAdd(repoRoot: string): void {
  void invoke("fs_watch_git_add", {
    repoRoot,
    workspace: currentWorkspaceEnv(),
  }).catch(() => {});
}

export function watchGitRemove(repoRoot: string): void {
  void invoke("fs_watch_git_remove", {
    repoRoot,
    workspace: currentWorkspaceEnv(),
  }).catch(() => {});
}

export function listenFsChanged(
  handler: (changes: FsChange[]) => void,
): Promise<() => void> {
  return getCurrentWebviewWindow().listen<FsChangedPayload>(
    FS_CHANGED_EVENT,
    (e) => handler(e.payload.changes),
  );
}

/** The path under a repo's `.git` dir, or null when the path is a worktree file. */
export function gitMetaPath(path: string): string | null {
  const norm = path.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/.git/");
  if (i < 0) return null;
  return norm.slice(i + "/.git/".length);
}

export function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return path.slice(0, i + 1) || path;
  return path.slice(0, i);
}
