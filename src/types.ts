export type DirEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
};

export type FileOperation = { kind: "move" | "delete"; path: string; newPath?: string };
export type FileMove = { oldPath: string; newPath: string; isDir: boolean };
export type WorkspaceMutation = {
  moves: FileMove[];
  deleted: string[];
  documents: { path: string; content: string; savedContent: string }[];
  warnings: string[];
  referencesUpdated: boolean;
};

export type LspPosition = { line: number; character: number };

export type LspDiagnostic = {
  range: { start: LspPosition; end: LspPosition };
  severity?: number;
  message: string;
  source?: string;
};

export type Tab = {
  path: string;
  name: string;
  content: string;
  savedContent: string;
  revision: number;
  external?: boolean;
};

export type DiagnosticsPayload = {
  workspace?: string;
  uri: string;
  path: string;
  diagnostics: LspDiagnostic[];
};

export type WorkspaceMode = "ai" | "ide";

export type ActivityView = "explorer" | "search" | "git" | "build";

export type SearchMatch = {
  path: string;
  line: number;
  column: number;
  prefix: string;
  matched: string;
  suffix: string;
  replacement?: string;
};

export type SearchOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  preserveCase: boolean;
};
export type SearchDocument = { path: string; text: string; savedText: string };
export type ReplaceRequest = SearchOptions & {
  query: string;
  replacement: string;
  path?: string;
  match?: SearchMatch;
};
export type ReplaceResult = {
  count: number;
  documents: { path: string; content: string; savedContent: string }[];
};

export type FileMatch = {
  path: string;
};

export type GitChange = {
  path: string;
  index: string;
  worktree: string;
  label: string;
  staged: boolean;
  untracked: boolean;
};

export type GitStatus = {
  isRepo: boolean;
  branch: string;
  changes: GitChange[];
  upstream: string | null;
  ahead: number;
  behind: number;
  merging: boolean;
  cherryPicking: boolean;
};

export type GitBranch = {
  name: string;
  current: boolean;
  remote: boolean;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  subject: string;
  refs: string[];
  unpushed: boolean;
};

export type GitLog = {
  commits: GitCommit[];
  truncated: boolean;
  remotes: string[];
};

export type GitCommitFile = {
  path: string;
  oldPath: string | null;
  status: string;
};

export type GitDiffLine = {
  kind: "add" | "remove" | "context";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export type GitFileDiff = {
  lines: GitDiffLine[];
  added: number;
  removed: number;
  isNew: boolean;
};

export type MergeOutcome = {
  status: GitStatus;
  conflicts: string[];
};

export type CheckoutOutcome = {
  switched: boolean;
  needsDecision: boolean;
  stashed: boolean;
};

export type RevealRequest = {
  path: string;
  line: number;
  column: number;
  nonce: number;
};

export type TerminalKind = "agent" | "shell" | "task";

export type AgentId = "opencode" | "pi" | "claude" | "agy";

export type TerminalTab = {
  id: string;
  title: string;
  kind: TerminalKind;
  command?: string;
  agent?: AgentId;
  exited?: boolean;
};

export type PtyDataPayload = {
  id: string;
  data: number[];
};

export type PtyExitPayload = {
  id: string;
};

export type FsChangedPayload = {
  workspace?: string;
  paths: string[];
};

export type WorkspaceTask = {
  id: string;
  label: string;
  command: string;
  group: string;
  kind: string;
};

export type WorkspaceTasks = {
  projectTypes: string[];
  build: WorkspaceTask | null;
  play: WorkspaceTask | null;
  tasks: WorkspaceTask[];
};

export function basename(path: string): string {
  const clean = path.startsWith("jdt://") ? path.split(/[?#]/, 1)[0] : path;
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function makeTab(path: string, content: string): Tab {
  return {
    path,
    name: basename(path),
    content,
    savedContent: content,
    revision: 0,
  };
}
