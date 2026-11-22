import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(path.join(process.cwd(), "package.json"));
const ts = require("typescript");
const source = ts.createSourceFile("App.tsx", readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map();
let closeEffect;
function collect(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
    && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(source) === "useCallback") {
    callbacks.set(node.name.text, node.initializer.arguments[0].getText(source));
  }
  if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect"
    && node.arguments[0].getText(source).includes("onCloseRequested(")) closeEffect = node.arguments[0].getText(source);
  ts.forEachChild(node, collect);
}
collect(source);

// Execute the application's actual callbacks; only React state and I/O are replaced.
function executable(text, environment) {
  assert.ok(text, "Application callback exists");
  const compiled = ts.transpileModule(`const callback = ${text}; return callback;`, {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(environment), compiled)(...Object.values(environment));
}
function callback(name, environment) { return executable(callbacks.get(name), environment); }
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const tab = (content = "new text", savedContent = "old text", name = "main.ts") =>
  ({ path: name, name, content, savedContent, revision: 0 });

function editor(initialTabs = [tab()]) {
  const writes = [], notifications = [], closedDocuments = [];
  const environment = {
    api: {
      saveFile: async (workspace, path, content) => { writes.push({ workspace, path, content }); },
      flushSaves: async () => {},
    },
    fileMutationRef: { current: null },
    tabsRef: { current: initialTabs },
    workspaceRef: { current: "C:/project" },
    fileRefreshes: { current: new Map() },
    activePathRef: { current: "main.ts" },
    diffPathRef: { current: null },
    closingRef: { current: false },
    closeConfirmedRef: { current: false },
    deferredFsChanges: { current: new Set() },
    cancelAutosaves: () => {},
    setMutatingFiles: () => {},
    scheduleAutosave: () => {},
    handleFsChanged: () => {},
    syncSavedFile: () => {},
    closeIntelligence: async (workspace, path) => { closedDocuments.push({ workspace, path }); },
    notify: (message) => notifications.push(message),
    setTabs: (value) => { environment.tabsRef.current = typeof value === "function" ? value(environment.tabsRef.current) : value; },
    setExplorerVersion: () => {}, setGitVersion: () => {}, setDiagnostics: () => {},
    setActivePath: () => {}, setDiffPath: () => {}, setCloseConfirmOpen: () => {},
    closeWindow: async () => {},
  };
  environment.saveContent = callback("saveContent", environment);
  environment.saveBeforeBuild = callback("saveBeforeBuild", environment);
  environment.finishRevert = callback("finishRevert", environment);
  return { environment, writes, notifications, closedDocuments };
}

test("closing a dirty tab waits for its disk write and queued saves", async () => {
  const { environment, writes } = editor();
  const write = deferred(), flush = deferred();
  environment.api.saveFile = (...args) => { writes.push(args); return write.promise; };
  environment.api.flushSaves = () => flush.promise;
  const closing = callback("closeTab", environment)("main.ts");
  assert.equal(environment.tabsRef.current.length, 1);
  write.resolve();
  await tick();
  assert.equal(environment.tabsRef.current.length, 1);
  flush.resolve();
  await closing;
  assert.equal(environment.tabsRef.current.length, 0);
  assert.equal(writes.length, 1);
});

test("a failed tab save retains the dirty buffer and reports the error", async () => {
  const { environment, notifications, closedDocuments } = editor();
  environment.api.saveFile = async () => { throw new Error("disk full"); };
  await callback("closeTab", environment)("main.ts");
  assert.equal(environment.tabsRef.current[0].content, "new text");
  assert.notEqual(environment.tabsRef.current[0].content, environment.tabsRef.current[0].savedContent);
  assert.match(notifications.join(" "), /disk full/);
  assert.equal(closedDocuments.length, 0);
});

test("new edits during tab close keep the tab open", async () => {
  const { environment, notifications } = editor();
  const write = deferred();
  environment.api.saveFile = () => write.promise;
  const closing = callback("closeTab", environment)("main.ts");
  environment.tabsRef.current = [{ ...environment.tabsRef.current[0], content: "newer text" }];
  write.resolve();
  await closing;
  assert.equal(environment.tabsRef.current[0].content, "newer text");
  assert.equal(environment.tabsRef.current[0].savedContent, "new text");
  assert.match(notifications.join(" "), /rimasta aperta/);
});

test("closing a clean tab still waits for an earlier save and retains it if flushing fails", async () => {
  const { environment, writes, notifications } = editor([tab("same", "same")]);
  const flush = deferred();
  environment.api.flushSaves = () => flush.promise;
  const closing = callback("closeTab", environment)("main.ts");
  assert.equal(environment.tabsRef.current.length, 1);
  flush.reject(new Error("queued write failed"));
  await closing;
  assert.equal(environment.tabsRef.current.length, 1);
  assert.equal(writes.length, 0);
  assert.match(notifications.join(" "), /queued write failed/);
});

test("discard closes a deleted buffer without recreating its file", async () => {
  const { environment, writes } = editor();
  let flushed = false;
  environment.api.flushSaves = async () => { flushed = true; };
  await callback("closeTab", environment)("main.ts", { discard: true });
  assert.equal(environment.tabsRef.current.length, 0);
  assert.equal(writes.length, 0);
  assert.equal(flushed, false);
});

test("Git discard paths request an explicit buffer discard", async () => {
  for (const name of ["revertFile", "revertAll"]) {
    const { environment, writes } = editor();
    const closures = [];
    environment.api.gitRevertFile = async () => {};
    environment.api.gitRevertAll = async () => {};
    environment.api.readFile = async () => { throw new Error("deleted"); };
    environment.confirmAction = async () => true;
    environment.git = { changes: [{ path: "main.ts", untracked: name === "revertFile" }] };
    environment.closeTab = async (...args) => closures.push(args);
    if (name === "revertFile") await callback(name, environment)("main.ts", true);
    else await callback(name, environment)();
    assert.deepEqual(closures, [["main.ts", { discard: true }]]);
    assert.equal(writes.length, 0);
  }
});

test("save-all waits for pending writes even when all tabs initially appear clean", async () => {
  const { environment, writes } = editor([tab("same", "same")]);
  const flush = deferred();
  let finished = false;
  environment.api.flushSaves = () => flush.promise;
  const saving = environment.saveBeforeBuild().then((result) => { finished = true; return result; });
  await tick();
  assert.equal(finished, false);
  flush.resolve();
  assert.equal(await saving, true);
  assert.equal(writes.length, 0);
});

test("save-all rejects a queued write failure even with no dirty tabs", async () => {
  const { environment, notifications } = editor([tab("same", "same")]);
  environment.api.flushSaves = async () => { throw new Error("pending save failed"); };
  assert.equal(await environment.saveBeforeBuild(), false);
  assert.match(notifications.join(" "), /pending save failed/);
});

test("new edits during save-all prevent checkout, build or workspace switching", async () => {
  const { environment, notifications } = editor();
  const write = deferred();
  environment.api.saveFile = () => write.promise;
  const saving = environment.saveBeforeBuild();
  environment.tabsRef.current = [{ ...environment.tabsRef.current[0], content: "newer text" }];
  write.resolve();
  assert.equal(await saving, false);
  assert.equal(environment.tabsRef.current[0].savedContent, "new text");
  assert.equal(environment.tabsRef.current[0].content, "newer text");
  assert.match(notifications.join(" "), /nuove modifiche/);
});

test("a workspace switch is not issued while newer edits remain unsaved", async () => {
  const { environment } = editor();
  const write = deferred();
  environment.api.saveFile = () => write.promise;
  let opened = false;
  environment.api.openWorkspace = async () => { opened = true; return "C:/other"; };
  environment.confirmAction = async () => true;
  environment.canSwitchWorkspace = callback("canSwitchWorkspace", environment);
  environment.addRecent = () => {};
  environment.basename = (value) => value.split("/").pop();
  environment.setShowProjects = () => {};
  const opening = callback("openRecent", environment)("C:/other");
  await tick();
  environment.tabsRef.current = [{ ...environment.tabsRef.current[0], content: "newer text" }];
  write.resolve();
  await opening;
  assert.equal(opened, false);
  assert.equal(environment.tabsRef.current[0].content, "newer text");
});

test("window close waits for saves and ignores repeated close commands", async () => {
  const { environment } = editor();
  const write = deferred();
  environment.api.saveFile = () => write.promise;
  let closed = 0;
  environment.closeWindow = async () => { closed++; };
  const close = callback("confirmClose", environment);
  const closing = close();
  await close();
  assert.equal(closed, 0);
  assert.equal(environment.closeConfirmedRef.current, false);
  write.resolve();
  await closing;
  assert.equal(closed, 1);
  assert.equal(environment.closeConfirmedRef.current, true);
});

test("window remains open after a save failure and can be closed after retry", async () => {
  const { environment } = editor();
  let closed = 0;
  environment.api.saveFile = async () => { throw new Error("disk full"); };
  environment.closeWindow = async () => { closed++; };
  const close = callback("confirmClose", environment);
  await close();
  assert.equal(closed, 0);
  assert.equal(environment.closeConfirmedRef.current, false);
  assert.equal(environment.closingRef.current, false);
  environment.api.saveFile = async () => {};
  await close();
  assert.equal(closed, 1);
});

test("new edits during window shutdown keep the window open", async () => {
  const { environment } = editor();
  const write = deferred();
  environment.api.saveFile = () => write.promise;
  let closed = false;
  environment.closeWindow = async () => { closed = true; };
  const closing = callback("confirmClose", environment)();
  environment.tabsRef.current = [{ ...environment.tabsRef.current[0], content: "newer text" }];
  write.resolve();
  await closing;
  assert.equal(closed, false);
  assert.equal(environment.tabsRef.current[0].content, "newer text");
});

test("native close always waits for saving when the optional confirmation is disabled", async () => {
  const { environment } = editor();
  const flush = deferred();
  let listener, closed = 0, prevented = 0, prompted = 0;
  environment.api.flushSaves = () => flush.promise;
  environment.closeWindow = async () => { closed++; };
  environment.confirmClose = callback("confirmClose", environment);
  environment.isTauri = () => true;
  environment.onCloseRequested = async (handler) => { listener = handler; return () => {}; };
  environment.prefs = { confirmClose: false };
  environment.setCloseConfirmOpen = () => { prompted++; };
  const cleanup = executable(closeEffect, environment)();
  listener({ preventDefault() { prevented++; } });
  await tick();
  assert.equal(closed, 0);
  assert.equal(prevented, 1);
  assert.equal(prompted, 0);
  flush.resolve();
  await tick();
  assert.equal(closed, 1);
  cleanup();
});

test("native close preserves the optional confirmation before starting shutdown", async () => {
  const { environment, writes } = editor();
  let listener, prompted = 0, prevented = 0;
  environment.isTauri = () => true;
  environment.onCloseRequested = async (handler) => { listener = handler; return () => {}; };
  environment.prefs = { confirmClose: true };
  environment.setCloseConfirmOpen = () => { prompted++; };
  environment.confirmClose = callback("confirmClose", environment);
  const cleanup = executable(closeEffect, environment)();
  listener({ preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.equal(prompted, 1);
  assert.equal(writes.length, 0);
  environment.closeConfirmedRef.current = true;
  listener({ preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  cleanup();
});

function revertEditor() {
  const fixture = editor([tab(), tab("other edits", "other old", "other.ts")]);
  const { environment } = fixture;
  const scheduled = [], locks = [], cancelled = [], replayed = [];
  environment.autosaveTimers = { current: new Map([["main.ts", 1], ["other.ts", 2]]) };
  environment.window = { clearTimeout: (timer) => cancelled.push(timer) };
  environment.cancelAutosaves = callback("cancelAutosaves", environment);
  environment.setMutatingFiles = (locked) => locks.push(locked);
  environment.scheduleAutosave = (...args) => scheduled.push(args);
  environment.handleFsChanged = (paths) => { assert.equal(environment.fileMutationRef.current, null); replayed.push(paths); };
  environment.finishRevert = callback("finishRevert", environment);
  environment.closeTab = callback("closeTab", environment);
  environment.confirmAction = async () => true;
  environment.git = { changes: [{ path: "main.ts", untracked: false }] };
  environment.api.gitRevertFile = async () => {};
  environment.api.gitRevertAll = async () => {};
  environment.api.readFile = async () => "HEAD text";
  return { ...fixture, scheduled, locks, cancelled, replayed };
}
const revert = (name, environment, untracked = false) => name === "revertFile"
  ? callback(name, environment)("main.ts", untracked) : callback(name, environment)();

for (const name of ["revertFile", "revertAll"]) {
  test(`${name} cancels autosave timers and waits for pending writes before Git`, async () => {
    const { environment, writes, scheduled, locks, cancelled, replayed } = revertEditor();
    const flush = deferred();
    let gitCalls = 0;
    environment.api.flushSaves = () => flush.promise;
    environment.api.gitRevertFile = environment.api.gitRevertAll = async () => { gitCalls++; };
    // React does not publish setState synchronously: the ref must be updated too.
    environment.setTabs = () => {};
    environment.deferredFsChanges.current.add("main.ts");
    const reverting = revert(name, environment);
    await tick();
    assert.equal(gitCalls, 0);
    assert.equal(environment.fileMutationRef.current, "C:/project");
    assert.deepEqual(locks, [true]);
    assert.deepEqual(cancelled, [1, 2]);
    assert.equal(environment.autosaveTimers.current.size, 0);
    callback("handleChange", environment)("main.ts", "typed while locked");
    assert.equal(environment.tabsRef.current[0].content, "new text");
    flush.resolve();
    await reverting;
    assert.equal(gitCalls, 1);
    assert.equal(environment.tabsRef.current[0].content, "HEAD text");
    assert.equal(environment.tabsRef.current[0].savedContent, "HEAD text");
    assert.equal(environment.fileMutationRef.current, null);
    assert.deepEqual(locks, [true, false]);
    assert.deepEqual(scheduled, [["other.ts", "other edits"]]);
    assert.deepEqual(replayed, [["main.ts"]]);
    assert.equal(writes.length, 0);
  });

  test(`${name} unlocks and resumes remaining edits if pending saves fail`, async () => {
    const { environment, scheduled, locks, notifications } = revertEditor();
    let gitCalls = 0;
    environment.api.flushSaves = async () => { throw new Error("pending write failed"); };
    environment.api.gitRevertFile = environment.api.gitRevertAll = async () => { gitCalls++; };
    await revert(name, environment);
    assert.equal(gitCalls, 0);
    assert.equal(environment.fileMutationRef.current, null);
    assert.deepEqual(locks, [true, false]);
    assert.deepEqual(scheduled, [["main.ts", "new text"], ["other.ts", "other edits"]]);
    assert.match(notifications.join(" "), /pending write failed/);
  });

  test(`${name} unlocks after a Git failure without discarding buffers`, async () => {
    const { environment, scheduled, notifications, locks } = revertEditor();
    environment.api.gitRevertFile = environment.api.gitRevertAll = async () => { throw new Error("Git failed"); };
    await revert(name, environment);
    assert.equal(environment.fileMutationRef.current, null);
    assert.equal(environment.tabsRef.current[0].content, "new text");
    assert.deepEqual(locks, [true, false]);
    assert.deepEqual(scheduled, [["main.ts", "new text"], ["other.ts", "other edits"]]);
    assert.match(notifications.join(" "), /Git failed/);
  });

  test(`${name} rechecks the mutation lock after confirmation`, async () => {
    const { environment, locks } = revertEditor();
    const confirmation = deferred();
    let flushed = false;
    environment.confirmAction = () => confirmation.promise;
    environment.api.flushSaves = async () => { flushed = true; };
    const reverting = revert(name, environment);
    environment.fileMutationRef.current = "another mutation";
    confirmation.resolve(true);
    await reverting;
    assert.equal(flushed, false);
    assert.equal(environment.fileMutationRef.current, "another mutation");
    assert.deepEqual(locks, []);
  });

  test(`${name} discards untracked files while locked without recreating them`, async () => {
    const { environment, writes, scheduled } = revertEditor();
    environment.git.changes[0].untracked = true;
    await revert(name, environment, true);
    assert.deepEqual(environment.tabsRef.current.map((item) => item.path), ["other.ts"]);
    assert.equal(environment.fileMutationRef.current, null);
    assert.deepEqual(scheduled, [["other.ts", "other edits"]]);
    assert.equal(writes.length, 0);
  });
}

test("a reverted file that cannot be reloaded is not autosaved from its discarded buffer", async () => {
  const { environment, scheduled, notifications, writes } = revertEditor();
  environment.api.readFile = async () => { throw new Error("read unavailable"); };
  await revert("revertFile", environment);
  assert.deepEqual(environment.tabsRef.current.map((item) => item.path), ["other.ts"]);
  assert.deepEqual(scheduled, [["other.ts", "other edits"]]);
  assert.match(notifications.join(" "), /read unavailable/);
  assert.equal(environment.fileMutationRef.current, null);
  assert.equal(writes.length, 0);
});
