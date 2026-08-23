import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { joinPath, type DirEntry } from "@/modules/explorer/lib/useFileTree";

export function validSpaceFolderName(name: string): boolean {
  const value = name.trim();
  return value.length > 0 && value !== "." && value !== ".." &&
    !/[\\/\0]/.test(value) && value.length <= 255;
}

export function spaceRootPath(root: string, name: string): string {
  return joinPath(root, name.trim());
}

export async function listSpaceFolders(root: string): Promise<string[]> {
  const entries = await invoke<DirEntry[]>("fs_read_dir", {
    path: root,
    showHidden: true,
    gitDecorations: false,
    workspace: currentWorkspaceEnv(),
  });
  return entries
    .filter((entry) => entry.kind === "dir")
    .map((entry) => spaceRootPath(root, entry.name));
}

export async function createSpaceFolder(root: string, name: string): Promise<string> {
  if (!validSpaceFolderName(name)) throw new Error("invalid folder name");
  const path = spaceRootPath(root, name);
  await invoke("fs_create_dir", { path, workspace: currentWorkspaceEnv() });
  return path;
}

export async function renameSpaceFolder(root: string, oldName: string, newName: string): Promise<string> {
  if (!validSpaceFolderName(newName)) throw new Error("invalid folder name");
  const from = spaceRootPath(root, oldName);
  const to = spaceRootPath(root, newName);
  await invoke("fs_rename", { from, to, workspace: currentWorkspaceEnv() });
  return to;
}

export async function deleteSpaceFolder(path: string): Promise<void> {
  await invoke("fs_delete", { path, workspace: currentWorkspaceEnv() });
}
