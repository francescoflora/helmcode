import type { GitChange } from "../types";

export type ChangeKind = "added" | "modified" | "deleted";

export const CHANGE_LABELS: Record<ChangeKind, string> = {
  added: "Aggiunto",
  modified: "Modificato",
  deleted: "Eliminato",
};

export const CHANGE_BADGES: Record<ChangeKind, string> = {
  added: "U",
  modified: "M",
  deleted: "D",
};

const PRIORITY: Record<ChangeKind, number> = { added: 0, modified: 1, deleted: 2 };

export function changeKind(change: Pick<GitChange, "label" | "untracked">): ChangeKind {
  if (change.untracked || change.label === "A" || change.label === "U" || change.label === "?") return "added";
  if (change.label === "D") return "deleted";
  return "modified";
}

export function mergeChangeKind(current: ChangeKind | undefined, next: ChangeKind): ChangeKind {
  return current && PRIORITY[current] >= PRIORITY[next] ? current : next;
}

/** Build file and ancestor decorations. Explorer passes includeDeleted: false. */
export function buildChangeMap(
  changes: GitChange[],
  options: { includeDeleted?: boolean } = {},
): Map<string, ChangeKind> {
  const includeDeleted = options.includeDeleted ?? true;
  const map = new Map<string, ChangeKind>();
  for (const change of changes) {
    const kind = changeKind(change);
    if (!includeDeleted && kind === "deleted") continue;
    const path = normalize(change.path);
    if (!path) continue;
    map.set(path, mergeChangeKind(map.get(path), kind));
    let parent = path;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (!parent) break;
      map.set(parent, mergeChangeKind(map.get(parent), kind));
    }
  }
  return map;
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}
