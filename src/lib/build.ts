import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { WorkspaceTask } from "../types";

export type BuildDiagnostic = {
  /** Empty for project-level diagnostics that have no source location. */
  path: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  message: string;
};

export type TaskEvent = {
  id: string;
  kind: "output" | "finished";
  stream?: "stdout" | "stderr";
  text?: string;
  code?: number | null;
  cancelled?: boolean;
};

export type TaskRun = {
  id: string;
  output: string;
  state: "running" | "success" | "failed" | "cancelled";
  code?: number | null;
};

/** Append each run's streamed output once per flush, preserving event order. */
export function mergeTaskEvents<T extends TaskRun>(runs: T[], events: TaskEvent[], limit = 160000): T[] {
  const updates = new Map<string, { chunks: string[]; finished?: TaskEvent }>();
  for (const event of events) {
    let update = updates.get(event.id);
    if (!update) { update = { chunks: [] }; updates.set(event.id, update); }
    if (event.kind === "output") update.chunks.push(event.text ?? "");
    else update.finished = event;
  }
  return runs.map((run) => {
    const update = updates.get(run.id);
    if (!update) return run;
    const next = { ...run, output: (run.output + update.chunks.join("")).slice(-limit) };
    if (update.finished) {
      next.code = update.finished.code;
      next.state = update.finished.cancelled ? "cancelled" : update.finished.code === 0 ? "success" : "failed";
    }
    return next;
  });
}

export const buildApi = {
  run: (taskId: string, runId: string) => invoke<void>("task_run", { taskId, runId }),
  stop: (runId: string) => invoke<void>("task_stop", { runId }),
};

export function onTaskEvent(handler: (event: TaskEvent) => void): Promise<UnlistenFn> {
  return listen<TaskEvent>("task-event", (event) => handler(event.payload));
}

export function stripBuildAnsi(output: string): string {
  return output.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "\n");
}

function sourcePath(path: string, workspace: string, task?: WorkspaceTask): string {
  let value = path.trim().replace(/^["'`]|["'`]$/g, "");
  if (value.startsWith("file://")) {
    try { value = decodeURIComponent(new URL(value).pathname).replace(/^\/(?=[a-z]:)/i, ""); } catch { /* Keep original text. */ }
  }
  if (!/^(?:[a-z]:[\\/]|[\\/])/i.test(value)) {
    const base = task?.id.startsWith("cargo:tauri:") && !/^src-tauri[\\/]/.test(value)
      ? `${workspace}/src-tauri` : workspace;
    value = `${base}/${value}`;
  }
  const windows = /^[a-z]:/i.test(value) || workspace.includes("\\");
  const prefix = value.startsWith("\\\\") ? "//" : value.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && !/^[a-z]:$/i.test(parts[parts.length - 1])) parts.pop();
    else if (part !== "..") parts.push(part);
  }
  const normalized = prefix + parts.join("/");
  const root = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  const comparablePath = windows ? normalized.toLowerCase() : normalized;
  const comparableRoot = windows ? root.toLowerCase() : root;
  // File commands accept workspace-relative paths only. External diagnostics remain
  // visible as project problems, without exposing an invalid navigation target.
  return comparablePath.startsWith(`${comparableRoot}/`) ? normalized.slice(root.length + 1) : "";
}

/** Parse common TypeScript, Rust/Cargo, GCC/Clang, MSVC, ESLint and esbuild messages. */
export function parseBuildDiagnostics(output: string, workspace: string, task?: WorkspaceTask): BuildDiagnostic[] {
  const diagnostics: BuildDiagnostic[] = [];
  const keys = new Set<string>();
  let pending: { severity: "error" | "warning"; message: string } | null = null;
  let eslintPath = "";
  const add = (path: string, line: number, column: number, severity: "error" | "warning", message: string) => {
    const diagnostic: BuildDiagnostic = {
      path: path ? sourcePath(path, workspace, task) : "",
      line: Math.max(1, line), column: Math.max(1, column), severity, message: message.trim(),
    };
    const key = `${diagnostic.path}:${diagnostic.line}:${diagnostic.column}:${severity}:${diagnostic.message}`;
    if (!keys.has(key)) { keys.add(key); diagnostics.push(diagnostic); }
  };
  const flushPending = () => {
    if (pending) add("", 1, 1, pending.severity, pending.message);
    pending = null;
  };

  for (const raw of stripBuildAnsi(output).split("\n")) {
    const text = raw.trim();
    // tsc / MSVC: src/file.ts(10,5): error TS2322: ...
    let match = text.match(/^(.+?)\((\d+)(?:,\s*(\d+))?\)\s*:\s*(?:fatal\s+)?(error|warning)\s*:?\s*(.*)$/i);
    if (match) {
      flushPending();
      add(match[1], +match[2], +(match[3] || 1), match[4].toLowerCase() as "error" | "warning", match[5]);
      continue;
    }
    // tsc --pretty false / GCC / Clang: src/file.ts:10:5: error: ...
    match = text.match(/^(.+?):(\d+)(?::(\d+))?\s*:\s*(?:fatal\s+)?(error|warning)(?:\s*:\s*|\s+)(.*)$/i);
    if (match) {
      flushPending();
      add(match[1], +match[2], +(match[3] || 1), match[4].toLowerCase() as "error" | "warning", match[5]);
      continue;
    }
    // Rust and esbuild put the location after the message.
    match = text.match(/^(?:-->|:::)?\s*(.+?):(\d+):(\d+):?$/);
    if (match && pending) {
      add(match[1], +match[2], +match[3], pending.severity, pending.message);
      pending = null;
      continue;
    }
    // Rust: error[E0308]: ...; esbuild: ✘ [ERROR] ...
    match = text.match(/^(error|warning)(\[[^\]]+\])?:\s*(.+)$/i)
      ?? text.match(/^[✘▲×!]?[\s]*\[(ERROR|WARNING)\]()\s*(.+)$/i);
    if (match) {
      if (/generated \d+ warnings?|could not compile|build failed|aborting due to/i.test(match[3])) continue;
      flushPending();
      pending = { severity: match[1].toLowerCase() as "error" | "warning", message: `${match[2] ? `${match[2]} ` : ""}${match[3]}` };
      continue;
    }
    match = text.match(/^(error|warning)\s+(TS\d+:\s*.+)$/i);
    if (match) {
      flushPending();
      add("", 1, 1, match[1].toLowerCase() as "error" | "warning", match[2]);
      continue;
    }
    // ESLint's stylish formatter has a filename followed by line/column entries.
    match = text.match(/^(\d+):(\d+)\s+(error|warning)\s+(.+)$/i);
    if (match && eslintPath) {
      add(eslintPath, +match[1], +match[2], match[3].toLowerCase() as "error" | "warning", match[4]);
      continue;
    }
    if (/^(?:[a-z]:[\\/]|[./\\])[^<>|]*\.(?:[cm]?[jt]sx?|rs|c|cpp|h|vue|svelte)$/i.test(text)) eslintPath = text;
  }
  flushPending();
  return diagnostics;
}
