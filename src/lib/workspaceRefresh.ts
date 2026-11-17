import type { GitStatus, Tab } from "../types";

/** Keep identical polling results from invalidating every Git-dependent panel. */
export function sameGitStatus(before: GitStatus, after: GitStatus): boolean {
  return before.isRepo === after.isRepo && before.branch === after.branch
    && before.upstream === after.upstream && before.ahead === after.ahead
    && before.behind === after.behind && before.merging === after.merging
    && before.cherryPicking === after.cherryPicking
    && before.changes.length === after.changes.length
    && before.changes.every((item, index) => {
      const next = after.changes[index];
      return item.path === next.path && item.index === next.index && item.worktree === next.worktree
        && item.label === next.label && item.staged === next.staged && item.untracked === next.untracked;
    });
}

/** An old disk read must not overwrite a newer save or reload; preserve local edits. */
export function applyDiskRefresh(tabs: Tab[], snapshot: Tab, disk: string): Tab[] {
  const index = tabs.findIndex((tab) => tab.path === snapshot.path && !tab.external);
  if (index < 0) return tabs;
  const tab = tabs[index];
  if (tab.savedContent !== snapshot.savedContent || tab.revision !== snapshot.revision || disk === tab.savedContent) return tabs;
  const next = [...tabs];
  next[index] = tab.content !== tab.savedContent ? { ...tab, savedContent: disk }
    : { ...tab, content: disk, savedContent: disk, revision: tab.revision + 1 };
  return next;
}
