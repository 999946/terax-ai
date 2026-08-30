import type { SourceControlFileEntry } from "./useSourceControlPanel";

export type ChangeNode = {
  path: string;
  name: string;
  kind: "dir" | "file";
  children: ChangeNode[];
  entry?: SourceControlFileEntry;
};

export type ChangeRow =
  | {
      kind: "dir";
      key: string;
      path: string;
      name: string;
      depth: number;
      isExpanded: boolean;
    }
  | {
      kind: "file";
      key: string;
      path: string;
      name: string;
      depth: number;
      entry: SourceControlFileEntry;
    };

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function buildChangeTree(entries: SourceControlFileEntry[]): ChangeNode[] {
  const roots: ChangeNode[] = [];
  const directories = new Map<string, ChangeNode>();

  for (const entry of entries) {
    const path = normalizePath(entry.path);
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let children = roots;
    let parentPath = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i];
      const dirPath = parentPath ? `${parentPath}/${name}` : name;
      let dir = directories.get(dirPath);
      if (!dir) {
        dir = { path: dirPath, name, kind: "dir", children: [] };
        directories.set(dirPath, dir);
        children.push(dir);
      }
      children = dir.children;
      parentPath = dirPath;
    }
    children.push({
      path,
      name: parts[parts.length - 1],
      kind: "file",
      children: [],
      entry,
    });
  }

  const sort = (nodes: ChangeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const node of nodes) if (node.kind === "dir") sort(node.children);
  };
  sort(roots);
  return roots;
}

export function flattenChangeTree(
  tree: ChangeNode[],
  expanded: ReadonlySet<string>,
): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const walk = (nodes: ChangeNode[], depth: number) => {
    for (const node of nodes) {
      if (node.kind === "dir") {
        const isExpanded = expanded.has(node.path);
        rows.push({
          kind: "dir",
          key: `dir:${node.path}`,
          path: node.path,
          name: node.name,
          depth,
          isExpanded,
        });
        if (isExpanded) walk(node.children, depth + 1);
      } else if (node.entry) {
        rows.push({
          kind: "file",
          key: `file:${node.path}`,
          path: node.path,
          name: node.name,
          depth,
          entry: node.entry,
        });
      }
    }
  };
  walk(tree, 0);
  return rows;
}

export function directoryPaths(tree: ChangeNode[]): string[] {
  const paths: string[] = [];
  const walk = (nodes: ChangeNode[]) => {
    for (const node of nodes) {
      if (node.kind === "dir") {
        paths.push(node.path);
        walk(node.children);
      }
    }
  };
  walk(tree);
  return paths;
}
