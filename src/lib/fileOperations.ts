import type { FileMove, Tab, WorkspaceMutation } from "../types";

export function pathContains(parent: string, path: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

export function movedPath(path: string, moves: FileMove[]): string {
  const move = [...moves].sort((a, b) => b.oldPath.length - a.oldPath.length)
    .find((candidate) => candidate.isDir ? pathContains(candidate.oldPath, path) : candidate.oldPath === path);
  return move ? move.newPath + path.slice(move.oldPath.length) : path;
}

export function applyMutationToTabs(tabs: Tab[], mutation: WorkspaceMutation): Tab[] {
  const documents = new Map(mutation.documents.map((document) => [document.path, document]));
  return tabs.filter((tab) => tab.external || !mutation.deleted.some((path) => pathContains(path, tab.path))).map((tab) => {
    if (tab.external) return tab;
    const path = movedPath(tab.path, mutation.moves);
    const document = documents.get(path);
    const content = document?.content ?? tab.content;
    return {
      ...tab, path, name: path.split("/").pop() ?? path, content,
      savedContent: document?.savedContent ?? tab.savedContent,
      revision: tab.revision + (content !== tab.content ? 1 : 0),
    };
  });
}
