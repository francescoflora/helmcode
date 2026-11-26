import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { CompletionContext, nextSnippetField } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";

const source = readFileSync(new URL("../src/lib/intelligence.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/(["'])(@(?:codemirror|tauri-apps)\/[^"']+)\1/g,
  (_match, _quote, name) => JSON.stringify(import.meta.resolve(name)));
const intelligence = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const position = (line, character) => ({ line, character });
const range = (from, to, line = 0) => ({ start: position(line, from), end: position(line, to) });
const contextFor = (doc, pos = doc.length, extensions = []) => {
  const state = EditorState.create({ doc, selection: { anchor: pos }, extensions });
  return new CompletionContext(state, pos, true);
};
const fakeView = state => ({
  state,
  dispatch(transaction) { this.state = transaction.state; },
});

test("LSP positions retain UTF-16 offsets around emoji, non-ASCII identifiers and newlines", () => {
  const context = contextFor("😀 const café = 1;\nfoo");
  assert.deepEqual(intelligence.positionAt(context.state, 3), position(0, 3));
  assert.equal(intelligence.offsetAt(context.state.doc, position(0, 3)), 3);
  const secondLine = context.state.doc.line(2).from;
  assert.deepEqual(intelligence.positionAt(context.state, secondLine + 2), position(1, 2));
  assert.equal(intelligence.offsetAt(context.state.doc, position(1, 2)), secondLine + 2);
  for (const invalid of [position(-1, 0), position(2, 0), position(0, 99), position(0, -1), position(0.5, 1)]) {
    assert.equal(intelligence.offsetAt(context.state.doc, invalid), null);
  }
});

test("workspace file mutations suspend new semantic requests and resume without affecting other projects", async () => {
  const previousWindow = globalThis.window;
  const calls = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args });
    return command === "lsp_sync_file" ? { state: "ready", language: "java" } : [];
  } } };
  try {
    intelligence.suspendIntelligence("C:/moving", true);
    await assert.rejects(intelligence.syncIntelligence("C:/moving", "Main.java", "class Main {}"), /Aggiornamento/);
    await assert.rejects(intelligence.navigateSymbol("C:/moving", "Main.java", "class Main {}", position(0, 8), "auto"), /Aggiornamento/);
    assert.equal(await intelligence.semanticCompletionSource({ workspace: "C:/moving", path: "Main.java" })(contextFor("pri")), null);
    await intelligence.saveIntelligence("C:/moving", "Main.java", "class Main {}");
    assert.equal(calls.length, 0);
    await intelligence.closeIntelligence("C:/moving", "Main.java");
    assert.equal(calls[0].command, "lsp_close_file");
    await intelligence.syncIntelligence("C:/other", "Main.java", "class Main {}");
    intelligence.suspendIntelligence("C:/moving", false);
    await intelligence.syncIntelligence("C:/moving", "Main.java", "class Main {}");
    assert.equal(calls.filter((call) => call.command === "lsp_sync_file").length, 2);
  } finally { intelligence.suspendIntelligence("C:/moving", false); globalThis.window = previousWindow; }
});

test("completion applies the server replacement range and import in one transaction", () => {
  const context = contextFor("const value = foobar;", 17);
  const result = intelligence.completionResult([{
    label: "format", kind: 3,
    textEdit: { range: range(14, 20), newText: "format" },
    additionalTextEdits: [{ range: range(0, 0), newText: 'import { format } from "lib";\n' }],
  }], context, "main.ts");
  const view = fakeView(context.state);
  result.options[0].apply(view, result.options[0], result.from, context.pos);
  assert.equal(view.state.doc.toString(), 'import { format } from "lib";\nconst value = format;');
  assert.equal(view.state.selection.main.from, 'import { format } from "lib";\nconst value = format'.length);
});

test("LSP snippets preserve selected fields and map them through additional imports", () => {
  const context = contextFor("pri");
  const result = intelligence.completionResult([{
    label: "println", insertTextFormat: 2,
    textEdit: { range: range(0, 3), newText: "printer.println(${1:value});$0" },
    additionalTextEdits: [{ range: range(0, 0), newText: "import printer;\n" }],
  }], context, "Main.java");
  const view = fakeView(context.state);
  result.options[0].apply(view, result.options[0], 0, 3);
  assert.equal(view.state.doc.toString(), "import printer;\nprinter.println(value);");
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), "value");
  assert.equal(nextSnippetField({ state: view.state, dispatch: tr => view.dispatch(tr) }), true);
  assert.equal(view.state.selection.main.from, view.state.doc.length);
});

test("LSP completion list defaults and insert/replace edits remove the entire suffix", () => {
  const context = contextFor("methodCall", 3);
  const result = intelligence.completionResult({
    isIncomplete: true,
    itemDefaults: { editRange: { insert: range(0, 3), replace: range(0, 10) }, insertTextFormat: 2 },
    items: [{ label: "method", textEditText: "method(${1:value})$0" }],
  }, context, "file.ts");
  const view = fakeView(context.state);
  result.options[0].apply(view, result.options[0], 0, 3);
  assert.equal(view.state.doc.toString(), "method(value)");
  assert.equal(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to), "value");
});

test("invalid ranges, overlapping imports and stale completions cannot alter the document", () => {
  const context = contextFor("foo");
  assert.equal(intelligence.completionResult([{
    label: "bar", textEdit: { range: range(0, 99), newText: "bar" },
  }], context, "file.ts"), null);
  const overlap = intelligence.completionResult([{
    label: "bar", textEdit: { range: range(0, 3), newText: "bar" },
    additionalTextEdits: [{ range: range(1, 2), newText: "delete" }],
  }], context, "file.ts");
  const view = fakeView(context.state);
  overlap.options[0].apply(view, overlap.options[0], 0, 3);
  assert.equal(view.state.doc.toString(), "foo");
  const result = intelligence.completionResult([{ label: "bar" }], context, "file.ts");
  view.state = view.state.update({ changes: { from: 3, insert: "x" } }).state;
  result.options[0].apply(view, result.options[0], 0, 4);
  assert.equal(view.state.doc.toString(), "foox");
});

test("LSP snippets translate choices, numeric tab stops, filename variables and escaped dollars", () => {
  const template = intelligence.lspSnippetTemplate("${1|first,second|} $2 $TM_FILENAME ${TM_FILENAME_BASE} \\$literal $0", "src/Main.java");
  const context = contextFor("x");
  const result = intelligence.completionResult([{
    label: "example", insertTextFormat: 2,
    insertText: "${1|first,second|} $2 $TM_FILENAME ${TM_FILENAME_BASE} \\$literal $0",
  }], context, "src/Main.java");
  assert.ok(template.includes("${1:first}"));
  const view = fakeView(context.state);
  result.options[0].apply(view, result.options[0], 0, 1);
  assert.equal(view.state.doc.toString(), "first  Main.java Main $literal ");
});

test("Java keywords and print snippets work without a language server; member keywords are suppressed", () => {
  const source = intelligence.localCompletionSource("Main.java");
  const result = source(contextFor("pri"));
  assert.ok(result.options.some(option => option.label === "private"));
  const print = result.options.find(option => option.label === "println");
  const view = fakeView(contextFor("pri").state);
  print.apply(view, print, 0, 3);
  assert.equal(view.state.doc.toString(), "System.out.println(value);");
  assert.equal(source(contextFor("object.pri")), null);
});

test("native language completion sources remain registered alongside semantic and local sources", () => {
  const language = javascript();
  const baseline = EditorState.create({ doc: "con", extensions: [language] });
  const state = EditorState.create({ doc: "con", extensions: [language, intelligence.intelligenceExtension({ workspace: "C:/project", path: "main.js" })] });
  const native = baseline.languageDataAt("autocomplete", 3);
  const combined = state.languageDataAt("autocomplete", 3);
  assert.ok(native.length > 0);
  assert.equal(combined.length, native.length + 3);
  for (const source of native) assert.ok(combined.includes(source));
});

test("semantic completion sends unsaved text and ignores a late response after newer input", async () => {
  const previousWindow = globalThis.window;
  const calls = [];
  const pending = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke(command, args) {
    calls.push({ command, args });
    return new Promise(resolve => pending.push(resolve));
  } } };
  try {
    const source = intelligence.semanticCompletionSource({ workspace: "C:/project", path: "Main.java" });
    const first = source(contextFor("pri"));
    const second = source(contextFor("prin"));
    assert.equal(calls[0].command, "lsp_completion");
    assert.equal(calls[0].args.text, "pri");
    assert.deepEqual({ line: calls[0].args.line, character: calls[0].args.character }, position(0, 3));
    assert.equal(calls[0].args.expectedWorkspace, "C:/project");
    pending[1]([{ label: "println" }]);
    assert.equal((await second).options[0].label, "println");
    pending[0]([{ label: "private" }]);
    assert.equal(await first, null);
  } finally { globalThis.window = previousWindow; }
});

test("semantic completion failure leaves fallback completion usable", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async () => { throw new Error("jdtls missing"); } } };
  try {
    const result = await intelligence.semanticCompletionSource({ workspace: "C:/project", path: "Main.java" })(contextFor("pri"));
    assert.equal(result, null);
    assert.ok(intelligence.localCompletionSource("Main.java")(contextFor("pri")).options.length);
  } finally { globalThis.window = previousWindow; }
});

test("contextual navigation forwards unsaved text and UTF-16 position while explicit implementation remains direct", async () => {
  const previousWindow = globalThis.window;
  const calls = [];
  const targets = [
    { path: "First.java", line: 3, column: 5 },
    { path: "Second.java", line: 7, column: 2 },
  ];
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args });
    return targets;
  } } };
  try {
    const text = "const marker = '😀'; service.greetUnsaved();";
    const state = EditorState.create({ doc: text });
    const position = intelligence.positionAt(state, text.indexOf("greetUnsaved") + 2);
    assert.equal(position.character, 31, "position counts the emoji as two UTF-16 code units");
    const contextual = await intelligence.navigateSymbol("C:/project", "Main.java", text, position, "auto");
    assert.deepEqual(calls[0], {
      command: "lsp_navigate",
      args: { expectedWorkspace: "C:/project", path: "Main.java", text, line: 0, character: 31, kind: "auto" },
    });
    assert.deepEqual(contextual, targets, "all implementation choices retain their server positions");
    const explicit = await intelligence.navigateSymbol("C:/project", "Main.java", text, position, "implementation");
    assert.equal(calls[1].args.kind, "implementation");
    assert.equal(calls.length, 2, "the frontend forwards one request for each chosen navigation mode");
    assert.deepEqual(explicit, targets);
  } finally { globalThis.window = previousWindow; }
});

test("a completion response cannot use offsets from an older document in the same view", async () => {
  const previousWindow = globalThis.window;
  let finish;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: () => new Promise(resolve => { finish = resolve; }) } };
  try {
    const state = contextFor("pri").state;
    const view = fakeView(state);
    const context = new CompletionContext(state, 3, true, view);
    const pending = intelligence.semanticCompletionSource({ workspace: "C:/project", path: "Main.java" })(context);
    view.state = state.update({ changes: { from: 0, insert: "// note\n" } }).state;
    finish([{ label: "private" }]);
    assert.equal(await pending, null);
  } finally { globalThis.window = previousWindow; }
});

test("unrecognized languages still complete words from the document", async () => {
  const state = EditorState.create({
    doc: "customIdentifier cust",
    extensions: [intelligence.intelligenceExtension({ workspace: "C:/project", path: "unknown.custom" })],
  });
  const sources = state.languageDataAt("autocomplete", state.doc.length);
  const result = await sources[2](new CompletionContext(state, state.doc.length, true));
  assert.ok(result.options.some(option => option.label === "customIdentifier"));
});

function delayedIpc() {
  const previousWindow = globalThis.window;
  const calls = [];
  globalThis.window = { __TAURI_INTERNALS__: { invoke(command, args) {
    return new Promise((resolve, reject) => { calls.push({ command, args, resolve, reject }); });
  } } };
  return { calls, restore: () => { globalThis.window = previousWindow; } };
}
const ready = message => ({ language: "java", state: "ready", message });

test("document sync runs one request at a time and coalesces queued snapshots to the newest", async () => {
  const ipc = delayedIpc();
  try {
    const first = intelligence.syncIntelligence("C:/queue-latest", "Main.java", "first");
    const superseded = intelligence.syncIntelligence("C:/queue-latest", "Main.java", "second");
    const latest = intelligence.syncIntelligence("C:/queue-latest", "Main.java", "third");
    assert.equal(ipc.calls.length, 1);
    assert.equal(ipc.calls[0].args.text, "first");
    ipc.calls[0].resolve(ready("first status"));
    assert.deepEqual(await first, ready("first status"));
    assert.equal(ipc.calls.length, 2);
    assert.equal(ipc.calls[1].args.text, "third");
    ipc.calls[1].resolve(ready("latest status"));
    assert.deepEqual(await superseded, ready("latest status"));
    assert.deepEqual(await latest, ready("latest status"));
  } finally { ipc.restore(); }
});

test("sync queues are independent per document and workspace while identical running snapshots share a request", async () => {
  const ipc = delayedIpc();
  try {
    const first = intelligence.syncIntelligence("C:/queue-isolation-a", "Main.java", "same");
    const duplicate = intelligence.syncIntelligence("C:\\queue-isolation-a", "Main.java", "same");
    const otherFile = intelligence.syncIntelligence("C:/queue-isolation-a", "Other.java", "other");
    const otherWorkspace = intelligence.syncIntelligence("C:/queue-isolation-b", "Main.java", "other project");
    assert.equal(ipc.calls.length, 3);
    ipc.calls.forEach((call, index) => call.resolve(ready(String(index))));
    const results = await Promise.all([first, duplicate, otherFile, otherWorkspace]);
    assert.deepEqual(results[0], results[1]);
    assert.notDeepEqual(results[0], results[2]);
    assert.notDeepEqual(results[0], results[3]);
  } finally { ipc.restore(); }
});

test("a failed sync rejects its callers and still starts the latest queued snapshot", async () => {
  const ipc = delayedIpc();
  try {
    const first = intelligence.syncIntelligence("C:/queue-failure", "Main.java", "old");
    const rejected = assert.rejects(first, /initialization failed/);
    const next = intelligence.syncIntelligence("C:/queue-failure", "Main.java", "new");
    ipc.calls[0].reject(new Error("initialization failed"));
    await rejected;
    assert.equal(ipc.calls.length, 2);
    assert.equal(ipc.calls[1].args.text, "new");
    ipc.calls[1].resolve(ready("recovered"));
    assert.deepEqual(await next, ready("recovered"));
  } finally { ipc.restore(); }
});

test("close cancels queued snapshots, waits for in-flight sync, and runs before a reopened document", async () => {
  const ipc = delayedIpc();
  try {
    const first = intelligence.syncIntelligence("C:/queue-close", "Main.java", "initializing");
    const discarded = intelligence.syncIntelligence("C:/queue-close", "Main.java", "discarded");
    const cancelled = assert.rejects(discarded, { name: "AbortError" });
    const close = intelligence.closeIntelligence("C:/queue-close", "Main.java");
    const reopen = intelligence.syncIntelligence("C:/queue-close", "Main.java", "reopened");
    await cancelled;
    assert.equal(ipc.calls.length, 1);
    ipc.calls[0].resolve(ready("initial status"));
    await first;
    assert.equal(ipc.calls[1].command, "lsp_close_file");
    assert.equal(ipc.calls.length, 2);
    ipc.calls[1].resolve();
    await close;
    assert.equal(ipc.calls[2].command, "lsp_sync_file");
    assert.equal(ipc.calls[2].args.text, "reopened");
    ipc.calls[2].resolve(ready("reopened status"));
    assert.deepEqual(await reopen, ready("reopened status"));
  } finally { ipc.restore(); }
});

test("save is an ordering barrier and newer edits sync after its saved snapshot", async () => {
  const ipc = delayedIpc();
  try {
    const first = intelligence.syncIntelligence("C:/queue-save", "Main.java", "initial");
    const save = intelligence.saveIntelligence("C:/queue-save", "Main.java", "saved on disk");
    const superseded = intelligence.syncIntelligence("C:/queue-save", "Main.java", "edit one");
    const latest = intelligence.syncIntelligence("C:/queue-save", "Main.java", "edit two");
    assert.equal(ipc.calls.length, 1);
    ipc.calls[0].resolve(ready("initial status"));
    await first;
    assert.equal(ipc.calls[1].command, "lsp_save_file");
    assert.equal(ipc.calls[1].args.text, "saved on disk");
    ipc.calls[1].resolve();
    await save;
    assert.equal(ipc.calls[2].command, "lsp_sync_file");
    assert.equal(ipc.calls[2].args.text, "edit two");
    ipc.calls[2].resolve(ready("latest edits"));
    assert.deepEqual(await superseded, ready("latest edits"));
    assert.deepEqual(await latest, ready("latest edits"));
  } finally { ipc.restore(); }
});

test("close discards pending saves and ignores a delayed save while close is queued", async () => {
  const ipc = delayedIpc();
  try {
    const first = intelligence.syncIntelligence("C:/queue-close-save", "Main.java", "initial");
    const pendingSave = intelligence.saveIntelligence("C:/queue-close-save", "Main.java", "old saved content");
    const close = intelligence.closeIntelligence("C:/queue-close-save", "Main.java");
    const delayedSave = intelligence.saveIntelligence("C:/queue-close-save", "Main.java", "late saved content");
    await Promise.all([pendingSave, delayedSave]);
    assert.equal(ipc.calls.length, 1);
    ipc.calls[0].resolve(ready("ready"));
    await first;
    assert.equal(ipc.calls.length, 2);
    assert.equal(ipc.calls[1].command, "lsp_close_file");
    ipc.calls[1].resolve();
    await close;
    assert.equal(ipc.calls.length, 2);
  } finally { ipc.restore(); }
});

test("close waits for a running save, then a reopened document can sync and save in order", async () => {
  const ipc = delayedIpc();
  try {
    const runningSave = intelligence.saveIntelligence("C:/queue-reopen-save", "Main.java", "first save");
    const close = intelligence.closeIntelligence("C:/queue-reopen-save", "Main.java");
    const reopen = intelligence.syncIntelligence("C:/queue-reopen-save", "Main.java", "reopened content");
    const reopenedSave = intelligence.saveIntelligence("C:/queue-reopen-save", "Main.java", "reopened content");
    assert.equal(ipc.calls[0].command, "lsp_save_file");
    ipc.calls[0].resolve();
    await runningSave;
    assert.equal(ipc.calls[1].command, "lsp_close_file");
    ipc.calls[1].resolve();
    await close;
    assert.equal(ipc.calls[2].command, "lsp_sync_file");
    ipc.calls[2].resolve(ready("reopened"));
    await reopen;
    assert.equal(ipc.calls[3].command, "lsp_save_file");
    assert.equal(ipc.calls[3].args.text, "reopened content");
    ipc.calls[3].resolve();
    await reopenedSave;
  } finally { ipc.restore(); }
});

test("on-demand language server installation invokes the backend installer command", async () => {
  const ipc = delayedIpc();
  try {
    const install = intelligence.installLanguageServer("java");
    assert.equal(ipc.calls.length, 1);
    assert.equal(ipc.calls[0].command, "lsp_install_server");
    assert.deepEqual(ipc.calls[0].args, { serverId: "java" });
    ipc.calls[0].resolve("Eclipse JDT LS 1.61.0 installato");
    assert.equal(await install, "Eclipse JDT LS 1.61.0 installato");
  } finally { ipc.restore(); }
});
