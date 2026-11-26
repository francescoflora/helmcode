import {
  autocompletion, completeAnyWord, pickedCompletion, snippet, snippetCompletion,
  type Completion, type CompletionContext, type CompletionResult, type CompletionSource,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import { EditorState, Transaction, type Extension, type Text, type TransactionSpec } from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";

export type InstallableServer = {
  id: string;
  label: string;
  requirement: string;
};

export type IntelligenceStatus = {
  language: string;
  state: "ready" | "missing" | "unsupported" | "error";
  server?: string | null;
  message?: string | null;
  installable?: InstallableServer | null;
};
export type NavigationKind = "auto" | "definition" | "declaration" | "implementation";
export type NavigationTarget = { path: string; line: number; column: number; external?: boolean };
export type Position = { line: number; character: number };
type Range = { start: Position; end: Position };
type TextEdit = { range: Range; newText: string };
type InsertReplaceEdit = { insert: Range; replace: Range; newText: string };
export type LspCompletionItem = {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  filterText?: string;
  sortText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEditText?: string;
  textEdit?: TextEdit | InsertReplaceEdit;
  additionalTextEdits?: TextEdit[];
  commitCharacters?: string[];
  deprecated?: boolean;
  tags?: number[];
};
export type LspCompletionResponse = LspCompletionItem[] | {
  items: LspCompletionItem[];
  isIncomplete?: boolean;
  itemDefaults?: {
    editRange?: Range | { insert: Range; replace: Range };
    insertTextFormat?: number;
    commitCharacters?: string[];
  };
} | null;

type Waiter<T> = { resolve: (result: T) => void; reject: (reason: unknown) => void };
type SyncOperation = { kind: "sync"; text: string; waiters: Waiter<IntelligenceStatus>[] };
type SaveOperation = { kind: "save"; text: string; waiters: Waiter<void>[] };
type CloseOperation = { kind: "close"; waiters: Waiter<void>[] };
type DocumentOperation = SyncOperation | SaveOperation | CloseOperation;
type DocumentQueue = {
  key: string;
  workspace: string;
  path: string;
  running: DocumentOperation | null;
  queued: DocumentOperation[];
};
const documentQueues = new Map<string, DocumentQueue>();
const suspendedWorkspaces = new Set<string>();
const workspaceKey = (workspace: string) => workspace.replace(/\\/g, "/");

export function suspendIntelligence(workspace: string, suspended: boolean): void {
  if (suspended) suspendedWorkspaces.add(workspaceKey(workspace));
  else suspendedWorkspaces.delete(workspaceKey(workspace));
}

function intelligenceSuspended(workspace: string): boolean {
  return suspendedWorkspaces.has(workspaceKey(workspace));
}

function documentQueue(workspace: string, path: string): DocumentQueue {
  const key = JSON.stringify([workspace.replace(/\\/g, "/"), path.replace(/\\/g, "/")]);
  let queue = documentQueues.get(key);
  if (!queue) {
    queue = { key, workspace, path, running: null, queued: [] };
    documentQueues.set(key, queue);
  }
  return queue;
}

function runDocumentQueue(queue: DocumentQueue): void {
  if (queue.running) return;
  const operation = queue.queued.shift();
  if (!operation) {
    if (documentQueues.get(queue.key) === queue) documentQueues.delete(queue.key);
    return;
  }
  queue.running = operation;
  void (async () => {
    try {
      if (operation.kind === "sync") {
        const status = await invoke<IntelligenceStatus>("lsp_sync_file", {
          expectedWorkspace: queue.workspace, path: queue.path, text: operation.text,
        });
        operation.waiters.forEach((waiter) => waiter.resolve(status));
      } else if (operation.kind === "save") {
        await invoke<void>("lsp_save_file", { expectedWorkspace: queue.workspace, path: queue.path, text: operation.text });
        operation.waiters.forEach((waiter) => waiter.resolve());
      } else {
        await invoke<void>("lsp_close_file", { expectedWorkspace: queue.workspace, path: queue.path });
        operation.waiters.forEach((waiter) => waiter.resolve());
      }
    } catch (error: unknown) {
      operation.waiters.forEach((waiter) => waiter.reject(error));
    } finally {
      queue.running = null;
      runDocumentQueue(queue);
    }
  })();
}

/** Keep initialization from allowing older background snapshots to overtake newer ones. */
export function syncIntelligence(workspace: string, path: string, text: string): Promise<IntelligenceStatus> {
  if (intelligenceSuspended(workspace)) return Promise.reject(new Error("Aggiornamento dei file in corso"));
  return new Promise((resolve, reject) => {
    const queue = documentQueue(workspace, path);
    const last = queue.queued.at(-1);
    const waiter = { resolve, reject };
    if (last?.kind === "sync") {
      last.text = text;
      last.waiters.push(waiter);
    } else if (!queue.queued.length && queue.running?.kind === "sync" && queue.running.text === text) {
      queue.running.waiters.push(waiter);
    } else {
      queue.queued.push({ kind: "sync", text, waiters: [waiter] });
    }
    runDocumentQueue(queue);
  });
}

/** Closing is a barrier: finish the active snapshot, discard queued ones, then allow reopening. */
export function closeIntelligence(workspace: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const queue = documentQueue(workspace, path);
    const cancelled = new Error("Sincronizzazione annullata: documento chiuso");
    cancelled.name = "AbortError";
    queue.queued = queue.queued.filter((operation) => {
      if (operation.kind === "close") return true;
      if (operation.kind === "sync") operation.waiters.forEach((waiter) => waiter.reject(cancelled));
      else operation.waiters.forEach((waiter) => waiter.resolve());
      return false;
    });
    const last = queue.queued.at(-1);
    if (last?.kind === "close") last.waiters.push({ resolve, reject });
    else if (queue.running?.kind === "close" && !queue.queued.length) queue.running.waiters.push({ resolve, reject });
    else queue.queued.push({ kind: "close", waiters: [{ resolve, reject }] });
    runDocumentQueue(queue);
  });
}
/** Preserve didSave ordering while allowing subsequent edits to queue a newer snapshot. */
export function saveIntelligence(workspace: string, path: string, text: string): Promise<void> {
  if (intelligenceSuspended(workspace)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const queue = documentQueue(workspace, path);
    const last = queue.queued.at(-1);
    // A delayed save callback must not reopen a document already waiting to close.
    if (last?.kind === "close" || (!queue.queued.length && queue.running?.kind === "close")) {
      resolve();
      return;
    }
    queue.queued.push({ kind: "save", text, waiters: [{ resolve, reject }] });
    runDocumentQueue(queue);
  });
}
export const readNavigationTarget = (workspace: string, path: string) =>
  invoke<string>("lsp_read_target", { expectedWorkspace: workspace, path });
export const installLanguageServer = (serverId: string) =>
  invoke<string>("lsp_install_server", { serverId });
export const navigateSymbol = (workspace: string, path: string, text: string, position: Position, kind: NavigationKind) =>
  intelligenceSuspended(workspace) ? Promise.reject(new Error("Aggiornamento dei file in corso")) :
    invoke<NavigationTarget[]>("lsp_navigate", { expectedWorkspace: workspace, path, text, ...position, kind });

/** CodeMirror and LSP both index JavaScript strings in UTF-16 code units. */
export function positionAt(state: EditorState, offset: number): Position {
  const line = state.doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

export function offsetAt(doc: Text, position: Position): number | null {
  if (!Number.isInteger(position.line) || !Number.isInteger(position.character) ||
      position.line < 0 || position.line >= doc.lines || position.character < 0) return null;
  const line = doc.line(position.line + 1);
  return position.character <= line.length ? line.from + position.character : null;
}

function editOffsets(doc: Text, range: Range): { from: number; to: number } | null {
  const from = offsetAt(doc, range.start), to = offsetAt(doc, range.end);
  return from !== null && to !== null && from <= to ? { from, to } : null;
}

const completionTypes: Record<number, string> = {
  1: "text", 2: "method", 3: "function", 4: "function", 5: "property", 6: "variable",
  7: "class", 8: "interface", 9: "namespace", 10: "property", 11: "text", 12: "constant",
  13: "enum", 14: "keyword", 15: "text", 16: "text", 17: "text", 18: "namespace",
  19: "text", 20: "property", 21: "constant", 22: "class", 23: "interface", 24: "keyword", 25: "type",
};

/** Convert LSP tab stops, choices and filename variables to CodeMirror's snippet syntax. */
export function lspSnippetTemplate(input: string, path: string): string {
  const filename = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const variables: Record<string, string> = {
    TM_FILENAME: filename, TM_FILENAME_BASE: filename.replace(/\.[^.]*$/, ""),
    TM_FILEPATH: path, TM_DIRECTORY: path.replace(/[\\/][^\\/]*$/, ""),
  };
  const escape = (text: string) => text.replace(/[{}]/g, "\\$&");
  const parse = (source: string): { template: string; text: string } => {
    let template = "", text = "";
    const literal = (value: string) => { template += escape(value); text += value; };
    for (let i = 0; i < source.length;) {
      if (source[i] === "\\" && /[$\\},|]/.test(source[i + 1] ?? "")) {
        literal(source[i + 1]); i += 2; continue;
      }
      if (source[i] !== "$") { literal(source[i++]); continue; }
      const short = /^(\d+|[A-Za-z_][\w]*)/.exec(source.slice(i + 1));
      let token: string;
      if (source[i + 1] === "{") {
        let end = i + 2, depth = 1;
        for (; end < source.length; end++) {
          if (source[end] === "\\") { end++; continue; }
          if (source[end] === "{") depth++;
          if (source[end] === "}" && --depth === 0) break;
        }
        if (depth !== 0) { literal(source[i++]); continue; }
        token = source.slice(i + 2, end); i = end + 1;
      } else if (short) { token = short[1]; i += short[0].length + 1; }
      else { literal(source[i++]); continue; }
      const field = /^(\d+)(?::([\s\S]*)|\|([\s\S]*)\|)?$/.exec(token);
      if (field) {
        const raw = field[2] ?? (field[3]?.match(/^(?:\\.|[^,])*/)?.[0] ?? "");
        const value = parse(raw).text;
        // CodeMirror's numbered default fields cannot contain braces.
        template += /[{}]/.test(value) ? escape(value) + "${" + field[1] + "}" :
          "${" + field[1] + (value ? ":" + escape(value) : "") + "}";
        text += value;
      } else {
        const variable = /^([A-Za-z_][\w]*)(?::([\s\S]*))?$/.exec(token);
        literal(variable ? variables[variable[1]] ?? parse(variable[2] ?? "").text : "");
      }
    }
    return { template, text };
  };
  return parse(input).template;
}

/** Convert raw LSP results without allowing late edits or server commands to run. */
export function completionResult(response: LspCompletionResponse, context: CompletionContext, path: string): CompletionResult | null {
  if (!response) return null;
  const list = Array.isArray(response) ? response : response.items;
  if (!Array.isArray(list) || !list.length) return null;
  const defaults = Array.isArray(response) ? undefined : response.itemDefaults;
  const word = context.matchBefore(/[\p{L}\p{N}_$]+/u);
  const from = word?.from ?? context.pos;
  const doc = context.state.doc;
  const options: Completion[] = [];
  for (const original of list) {
    if (!original || typeof original.label !== "string") continue;
    const item = { ...original };
    if (!item.textEdit && defaults?.editRange) {
      const range = defaults.editRange;
      item.textEdit = { ...("start" in range ? { range } : range), newText: item.textEditText ?? item.insertText ?? item.label };
    }
    const edit = item.textEdit;
    const primary = edit ? editOffsets(doc, "range" in edit ? edit.range : edit.replace) : null;
    if (edit && (!primary || primary.from > context.pos || primary.to < context.pos)) continue;
    const insert = edit?.newText ?? item.insertText ?? item.label;
    const isSnippet = (item.insertTextFormat ?? defaults?.insertTextFormat) === 2;
    const completion: Completion = {
      label: item.filterText || item.label,
      ...(item.filterText && item.filterText !== item.label ? { displayLabel: item.label } : {}),
      detail: item.detail,
      sortText: item.sortText,
      info: typeof item.documentation === "string" ? item.documentation : item.documentation?.value,
      type: completionTypes[item.kind ?? 1],
      commitCharacters: item.commitCharacters ?? defaults?.commitCharacters,
      boost: item.deprecated || item.tags?.includes(1) ? -20 : 10,
      apply(view, selected, currentFrom, currentTo) {
        if (!view.state.doc.eq(doc)) return;
        const mainRange = primary ?? { from: currentFrom, to: currentTo };
        const additional = (item.additionalTextEdits ?? []).map((extra) => {
          const offsets = editOffsets(doc, extra.range);
          return offsets && { ...offsets, insert: extra.newText };
        });
        if (additional.some((extra) => !extra)) return;
        const extras = additional.filter((extra) => extra !== null).sort((a, b) => a.from - b.from);
        const ranges = [...extras, mainRange].sort((a, b) => a.from - b.from || a.to - b.to);
        if (ranges.some((range, index) => index > 0 && range.from < ranges[index - 1].to)) return;
        const annotations = [pickedCompletion.of(selected), Transaction.userEvent.of("input.complete")];
        let main: TransactionSpec;
        if (isSnippet) {
          // Capture CodeMirror's snippet transaction, then compose imports atomically.
          let inserted: Transaction | undefined;
          snippet(lspSnippetTemplate(insert, path))({ state: view.state, dispatch: (transaction) => { inserted = transaction; } },
            selected, mainRange.from, mainRange.to);
          if (!inserted) return;
          const transaction = inserted as Transaction;
          main = { changes: transaction.changes, selection: transaction.selection, effects: transaction.effects, annotations };
        } else {
          main = { changes: { ...mainRange, insert }, selection: { anchor: mainRange.from + insert.length }, annotations };
        }
        view.dispatch(view.state.update(main, { changes: extras, scrollIntoView: true }));
      },
    };
    options.push(completion);
  }
  return options.length ? { from, to: context.pos, options, map: () => null } : null;
}

type IntelligenceOptions = { workspace: string; path: string; onStatus?: (status: IntelligenceStatus) => void };

export function semanticCompletionSource({ workspace, path }: IntelligenceOptions): CompletionSource {
  let serial = 0;
  return async (context) => {
    if (intelligenceSuspended(workspace)) return null;
    const word = context.matchBefore(/[\p{L}\p{N}_$]+/u);
    const previous = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos);
    if (!context.explicit && !word && !/[.>:/'"<]/.test(previous)) return null;
    const request = ++serial;
    let aborted = false;
    context.addEventListener("abort", () => { aborted = true; }, { onDocChange: true });
    try {
      const response = await invoke<LspCompletionResponse>("lsp_completion", {
        expectedWorkspace: workspace, path, text: context.state.doc.toString(),
        ...positionAt(context.state, context.pos),
        ...(!word && previous ? { triggerCharacter: previous } : {}),
      });
      if (intelligenceSuspended(workspace) || aborted || context.aborted || request !== serial ||
          (context.view && !context.view.state.doc.eq(context.state.doc))) return null;
      return completionResult(response, context, path);
    } catch {
      // The editor status from lsp_sync_file explains missing servers; native and local sources keep working.
      return null;
    }
  };
}

const keywords: Record<string, string> = {
  java: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public record return short static strictfp super switch synchronized this throw throws transient try var void volatile while yield true false null",
  js: "async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while yield",
  py: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
  rs: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
  c: "auto bool break case char const continue default do double else enum extern false float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while true nullptr",
  cs: "abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get if implicit in int interface internal is lock long namespace new null object operator out override params partial private protected public readonly record ref return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while yield",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil",
  php: "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof interface isset list match namespace new null or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false",
  rb: "alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield",
  kt: "abstract actual annotation as break by catch class companion const constructor continue data delegate do dynamic else enum expect external false field file final finally for fun get if import in infix init inline inner interface internal is lateinit noinline null object open operator out override package param private property protected public receiver reified return sealed set setparam super suspend tailrec this throw true try typealias typeof val value var vararg when where while",
  swift: "actor any as associatedtype async await break case catch class continue convenience default defer deinit didSet do dynamic else enum extension fallthrough false fileprivate final for func get guard if import in indirect infix init inout internal is lazy let mutating nil nonmutating open operator optional override postfix precedencegroup prefix private protocol public repeat required rethrows return self Self set some static struct subscript super switch throw throws true try typealias unowned var weak where while willSet",
  sql: "SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE DROP ALTER JOIN INNER LEFT RIGHT FULL OUTER ON GROUP BY ORDER ASC DESC HAVING LIMIT OFFSET AS AND OR NOT NULL IS IN EXISTS DISTINCT UNION ALL WITH CASE WHEN THEN ELSE END PRIMARY KEY REFERENCES INDEX DEFAULT TRUE FALSE",
  sh: "if then else elif fi for while in do done case esac function return export local readonly echo printf exit source break continue",
  ps1: "function param return if elseif else foreach for while do until switch try catch finally throw class enum using filter workflow begin process end break continue Write-Host Write-Output Get-Content Set-Content Get-ChildItem",
  lua: "and break do else elseif end false for function goto if in local nil not or repeat return then true until while",
  dart: "abstract as assert async await base break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for Function get hide if implements import in interface is late library mixin new null of on operator part required rethrow return sealed set show static super switch sync this throw true try type typedef var void when while with yield",
};
const aliases: Record<string, string> = {
  ts: "js", tsx: "js", jsx: "js", mjs: "js", cjs: "js", mts: "js", cts: "js",
  pyw: "py", pyi: "py", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", hh: "c",
  kts: "kt", bash: "sh", zsh: "sh", psm1: "ps1", psd1: "ps1",
};
const templates: Record<string, { label: string; template: string; detail: string }[]> = {
  java: [
    { label: "println", template: "System.out.println(${1:value});${0}", detail: "System.out.println" },
    { label: "print", template: "System.out.print(${1:value});${0}", detail: "System.out.print" },
    { label: "main", template: "public static void main(String[] args) {\n\t${0}\n}", detail: "Metodo main" },
  ],
  js: [{ label: "log", template: "console.log(${1:value});${0}", detail: "console.log" }],
  py: [{ label: "print", template: "print(${1:value})${0}", detail: "print" }],
  rs: [{ label: "println", template: 'println!("${1:message}");${0}', detail: "println!" }],
};

export function localCompletionSource(path: string): CompletionSource {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const language = aliases[extension] ?? extension;
  const words = (keywords[language] ?? "").split(" ").filter(Boolean);
  const options: Completion[] = words.map((label) => ({ label, type: "keyword", boost: -10 }));
  for (const item of templates[language] ?? []) options.push(snippetCompletion(item.template,
    { label: item.label, detail: item.detail, type: "function", boost: -5 }));
  return (context) => {
    const word = context.matchBefore(/[\p{L}\p{N}_$]+/u);
    if (!word || (!context.explicit && word.from === word.to)) return null;
    const node = syntaxTree(context.state).resolveInner(context.pos, -1);
    if (/Comment|String/.test(node.name)) return null;
    const before = context.state.sliceDoc(Math.max(0, word.from - 1), word.from);
    if (before === ".") return null;
    return options.length ? { from: word.from, options, validFor: /^[\p{L}\p{N}_$]*$/u } : null;
  };
}

export function intelligenceExtension(options: IntelligenceOptions): Extension {
  const semantic = semanticCompletionSource(options);
  const local = localCompletionSource(options.path);
  // Register additional sources rather than overriding the parser's HTML/CSS/etc. completions.
  return [
    autocompletion({ activateOnTyping: true, activateOnTypingDelay: 120 }),
    EditorState.languageData.of(() => [{ autocomplete: semantic }, { autocomplete: local }, { autocomplete: completeAnyWord }]),
  ];
}
