import type { DirEntry, FileOperation } from "../types";

const normalize = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "") || ".";

export function parentDirectory(path: string): string {
  return normalize(path).split("/").slice(0, -1).join("/") || ".";
}

export function isWithin(path: string, parent: string): boolean {
  const candidate = normalize(path).toLowerCase();
  const directory = normalize(parent).toLowerCase();
  return candidate === directory || candidate.startsWith(`${directory}/`);
}

/** A selected directory already carries all of its selected descendants. */
export function topLevelEntries(entries: readonly DirEntry[]): DirEntry[] {
  return entries.filter((entry, index) => entries.findIndex((item) => item.path === entry.path) === index &&
    !entries.some((parent) => parent !== entry && parent.isDir && parent.path !== entry.path && isWithin(entry.path, parent.path)));
}

export function ancestorDirectories(path: string): string[] {
  const parts = normalize(path).split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

export type CompactedDirectory = { chain: DirEntry[]; leaf: DirEntry; label: string };

/** Merge a chain of single-child directories into one displayed row. */
export function compactDirectory(entry: DirEntry, expanded: ReadonlySet<string>, children: Record<string, DirEntry[]>): CompactedDirectory {
  const chain = [entry];
  let current = entry;
  while (current.isDir && expanded.has(current.path) && Object.hasOwn(children, current.path)) {
    const entries = children[current.path];
    if (entries.length !== 1 || !entries[0].isDir) break;
    const child = entries[0];
    chain.push(child);
    if (!expanded.has(child.path)) break;
    current = child;
  }
  return { chain, leaf: chain[chain.length - 1], label: chain.map((item) => item.name).join(" \\ ") };
}

export function visibleEntries(entries: readonly DirEntry[], expanded: ReadonlySet<string>, children: Record<string, DirEntry[]>): DirEntry[] {
  const result: DirEntry[] = [];
  for (const entry of entries) {
    const { leaf } = compactDirectory(entry, expanded, children);
    result.push(leaf);
    if (leaf.isDir && expanded.has(leaf.path) && Object.hasOwn(children, leaf.path)) {
      result.push(...visibleEntries(children[leaf.path], expanded, children));
    }
  }
  return result;
}

export function remapExplorerPath(path: string, moves: readonly { oldPath: string; newPath: string }[]): string {
  const move = moves.filter((move) => isWithin(path, move.oldPath)).sort((a, b) => b.oldPath.length - a.oldPath.length)[0];
  return move ? `${move.newPath}${normalize(path).slice(normalize(move.oldPath).length)}` : path;
}

/** Plan one move per selected branch. The filesystem validates collisions again. */
export function dropOperations(entries: readonly DirEntry[], parent: string): FileOperation[] {
  const selected = topLevelEntries(entries);
  const directory = normalize(parent);
  const targets = new Set<string>();
  const operations: FileOperation[] = [];
  for (const entry of selected) {
    if (entry.isDir && isWithin(directory, entry.path)) throw new Error("Una cartella non può essere spostata al suo interno.");
    const newPath = directory === "." ? entry.name : `${directory}/${entry.name}`;
    const identity = newPath.toLowerCase();
    if (targets.has(identity)) throw new Error("Due elementi selezionati hanno lo stesso nome nella destinazione.");
    targets.add(identity);
    if (entry.path !== newPath) operations.push({ kind: "move", path: entry.path, newPath });
  }
  return operations;
}

export type DirectoryChain = { paths: string[]; children: Record<string, DirEntry[]>; leaf: DirEntry | null };

/** Open a single-child directory chain without opening any file automatically. */
export async function loadDirectoryChain(
  start: DirEntry,
  read: (path: string) => Promise<DirEntry[]>,
  isCurrent: () => boolean = () => true,
): Promise<DirectoryChain> {
  const result: DirectoryChain = { paths: [], children: {}, leaf: null };
  const visited = new Set<string>();
  let directory = start;
  while (isCurrent() && !visited.has(directory.path)) {
    visited.add(directory.path);
    const entries = await read(directory.path);
    if (!isCurrent()) return { paths: [], children: {}, leaf: null };
    result.paths.push(directory.path);
    Object.defineProperty(result.children, directory.path, { value: entries, enumerable: true, configurable: true, writable: true });
    result.leaf = directory;
    if (entries.length !== 1 || !entries[0].isDir) break;
    directory = entries[0];
  }
  return result;
}
