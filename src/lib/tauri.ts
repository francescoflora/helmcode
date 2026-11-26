import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  CheckoutOutcome,
  DiagnosticsPayload,
  DirEntry,
  FileMatch,
  FileOperation,
  FsChangedPayload,
  GitBranch,
  GitCommitFile,
  GitFileDiff,
  GitLog,
  GitStatus,
  MergeOutcome,
  PtyDataPayload,
  PtyExitPayload,
  SearchMatch,
  SearchOptions,
  SearchDocument,
  ReplaceRequest,
  ReplaceResult,
  WorkspaceTasks,
  WorkspaceMutation,
} from "../types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const pendingSaves = new Map<string, Promise<void>>();

function saveFile(expectedWorkspace: string, path: string, content: string): Promise<void> {
  // Disk writes run off the UI thread; keep successive saves of each file ordered.
  const key = `${expectedWorkspace}\0${path}`.replace(/\\/g, "/").toLowerCase();
  const previous = pendingSaves.get(key);
  const save = (previous ? previous.catch(() => undefined) : Promise.resolve())
    .then(() => invoke<void>("save_file", { expectedWorkspace, path, content }));
  pendingSaves.set(key, save);
  const cleanup = () => { if (pendingSaves.get(key) === save) pendingSaves.delete(key); };
  void save.then(cleanup, cleanup);
  return save;
}

export const api = {
  getWorkspace: () => invoke<string>("get_workspace"),
  pickFolder: () => invoke<string | null>("pick_folder"),
  openWorkspace: (path: string) => invoke<string>("open_workspace", { path }),
  createWorkspace: (parent: string, name: string, open = true) =>
    invoke<string>("create_workspace", { parent, name, open }),
  openNewWindow: (workspace: string | null) => invoke<void>("open_new_window", { workspace }),
  startupEmptyRequested: () => invoke<boolean>("startup_empty_requested"),
  listDirectory: (path: string) => invoke<DirEntry[]>("list_directory", { path }),
  createEntry: (expectedWorkspace: string, parent: string, name: string, isDir: boolean) => invoke<DirEntry>("create_entry", { expectedWorkspace, parent, name, isDir }),
  mutateEntries: (expectedWorkspace: string, operations: FileOperation[], documents: { path: string; text: string; savedText: string }[]) =>
    invoke<WorkspaceMutation>("mutate_entries", { expectedWorkspace, operations, documents }),
  readFile: (path: string) => invoke<string>("read_file_text", { path }),
  saveFile,
  flushSaves: () => Promise.all([...pendingSaves.values()]).then(() => undefined),
  ptyCreate: (id: string, rows: number, cols: number, agent: string | null = null) =>
    invoke<void>("pty_create", { id, rows, cols, agent }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, rows: number, cols: number) =>
    invoke<void>("pty_resize", { id, rows, cols }),
  ptySnapshot: (id: string) => invoke<number[]>("pty_snapshot", { id }),
  ptyClose: (id: string) => invoke<void>("pty_close", { id }),
  searchText: (query: string, caseSensitive: boolean, options?: SearchOptions, documents: SearchDocument[] = [], replacement?: string) =>
    invoke<SearchMatch[]>("search_text", { query, caseSensitive, options, documents, replacement }),
  replaceText: (expectedWorkspace: string, request: ReplaceRequest, documents: SearchDocument[]) =>
    invoke<ReplaceResult>("replace_text", { expectedWorkspace, request, documents }),
  searchFiles: (query: string) => invoke<FileMatch[]>("search_files", { query }),
  gitStatus: () => invoke<GitStatus>("git_status"),
  gitFetch: (expectedWorkspace: string) => invoke<GitStatus>("git_fetch", { expectedWorkspace }),
  gitBranches: (expectedWorkspace: string) => invoke<GitBranch[]>("git_branches", { expectedWorkspace }),
  gitCheckout: (expectedWorkspace: string, branch: string, remote: boolean, carryChanges: boolean | null = null) =>
    invoke<CheckoutOutcome>("git_checkout", { expectedWorkspace, branch, remote, carryChanges }),
  gitCreateBranch: (expectedWorkspace: string, name: string, base: string | null, keepChanges: boolean) =>
    invoke<GitStatus>("git_create_branch", { expectedWorkspace, name, base, keepChanges }),
  gitCommit: (expectedWorkspace: string, message: string, push: boolean) =>
    invoke<GitStatus>("git_commit", { expectedWorkspace, message, push }),
  gitPush: (expectedWorkspace: string) => invoke<GitStatus>("git_push", { expectedWorkspace }),
  gitPull: (expectedWorkspace: string) => invoke<MergeOutcome>("git_pull", { expectedWorkspace }),
  gitCherryPick: (expectedWorkspace: string, hash: string) =>
    invoke<MergeOutcome>("git_cherry_pick", { expectedWorkspace, hash }),
  gitMerge: (expectedWorkspace: string, source: string, target: string) =>
    invoke<MergeOutcome>("git_merge", { expectedWorkspace, source, target }),
  gitCompleteMerge: (expectedWorkspace: string) =>
    invoke<GitStatus>("git_complete_merge", { expectedWorkspace }),
  gitAbortMerge: (expectedWorkspace: string) =>
    invoke<GitStatus>("git_abort_merge", { expectedWorkspace }),
  gitResolveConflict: (expectedWorkspace: string, path: string, content: string) =>
    invoke<void>("git_resolve_conflict", { expectedWorkspace, path, content }),
  gitTakeSide: (expectedWorkspace: string, path: string, side: "ours" | "theirs") =>
    invoke<void>("git_take_side", { expectedWorkspace, path, side }),
  gitRevertFile: (expectedWorkspace: string, path: string) =>
    invoke<void>("git_revert_file", { expectedWorkspace, path }),
  gitRevertAll: (expectedWorkspace: string) =>
    invoke<void>("git_revert_all", { expectedWorkspace }),
  gitLog: (expectedWorkspace: string, limit: number) => invoke<GitLog>("git_log", { expectedWorkspace, limit }),
  gitCommitFiles: (expectedWorkspace: string, hash: string) => invoke<GitCommitFile[]>("git_commit_files", { expectedWorkspace, hash }),
  gitCommitFileDiff: (expectedWorkspace: string, hash: string, path: string, oldPath: string | null) =>
    invoke<GitFileDiff>("git_commit_file_diff", { expectedWorkspace, hash, path, oldPath }),
  workspaceTasks: () => invoke<WorkspaceTasks>("workspace_tasks"),
  lspOpen: (path: string, text: string) => invoke<void>("lsp_open_file", { path, text }),
};

export function onPtyData(handler: (payload: PtyDataPayload) => void): Promise<UnlistenFn> {
  return listen<PtyDataPayload>("pty-data", (event) => handler(event.payload));
}

export function onPtyExit(handler: (payload: PtyExitPayload) => void): Promise<UnlistenFn> {
  return listen<PtyExitPayload>("pty-exit", (event) => handler(event.payload));
}

export function onDiagnostics(handler: (payload: DiagnosticsPayload) => void): Promise<UnlistenFn> {
  return listen<DiagnosticsPayload>("lsp-diagnostics", (event) => handler(event.payload));
}

export function onWorkspaceChanged(handler: (workspace: string) => void): Promise<UnlistenFn> {
  return listen<string>("workspace-changed", (event) => handler(event.payload));
}

export function onFsChanged(handler: (payload: FsChangedPayload) => void): Promise<UnlistenFn> {
  return listen<FsChangedPayload>("fs-changed", (event) => handler(event.payload));
}

export function onLspInstallProgress(handler: (payload: { serverId: string; message: string }) => void): Promise<UnlistenFn> {
  return listen<{ serverId: string; message: string }>("lsp-install-progress", (event) => handler(event.payload));
}
