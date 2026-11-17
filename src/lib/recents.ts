export interface RecentProject {
  path: string;
  name: string;
  modifiedAt: string;
}

const RECENT_KEY = "helmcode.recent";
export const MAX_RECENT = 8;

const normalizePath = (path: string) => path.replace(/\\/g, "/").toLowerCase();

export function upsertRecent(
  list: RecentProject[],
  entry: RecentProject,
  max = MAX_RECENT,
): RecentProject[] {
  const target = normalizePath(entry.path);
  return [entry, ...list.filter((item) => normalizePath(item.path) !== target)].slice(0, max);
}

export function listRecents(): RecentProject[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is RecentProject =>
          typeof item?.path === "string" && typeof item?.name === "string")
      : [];
  } catch {
    return [];
  }
}

export function addRecent(path: string, name: string): void {
  try {
    const entry: RecentProject = { path, name, modifiedAt: new Date().toISOString() };
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(upsertRecent(listRecents(), entry)));
  } catch {
    /* localStorage può essere disabilitato */
  }
}

export function removeRecent(path: string): void {
  try {
    const target = normalizePath(path);
    window.localStorage.setItem(
      RECENT_KEY,
      JSON.stringify(listRecents().filter((item) => normalizePath(item.path) !== target)),
    );
  } catch {
    /* ignore */
  }
}
