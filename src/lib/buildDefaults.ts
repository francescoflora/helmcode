import type { WorkspaceTask } from "../types";

export type TaskKind = "build" | "play";
export type BuildDefaultStore = Record<string, { build?: string; play?: string }>;

export function workspaceKey(workspace: string): string {
  return workspace.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function defaultsFor(store: BuildDefaultStore, workspace: string): { build?: string; play?: string } {
  return store[workspaceKey(workspace)] ?? {};
}

export function withDefault(store: BuildDefaultStore, workspace: string, kind: TaskKind, taskId: string): BuildDefaultStore {
  const key = workspaceKey(workspace);
  return { ...store, [key]: { ...store[key], [kind]: taskId } };
}

/** Stored task when still available, then the detected default, then the first task of the requested kind. */
export function resolveDefaultTask(
  tasks: readonly WorkspaceTask[],
  kind: TaskKind,
  storedId: string | undefined,
  fallback: WorkspaceTask | null,
): WorkspaceTask | null {
  const stored = storedId ? tasks.find((task) => task.id === storedId) : undefined;
  if (stored) return stored;
  if (fallback && tasks.some((task) => task.id === fallback.id)) return fallback;
  return tasks.find((task) => task.kind === kind) ?? null;
}
