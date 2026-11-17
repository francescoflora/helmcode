import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function source(name) {
  const code = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  new Function("exports", compiled)(exports);
  return exports;
}
const { createCoalescedRequest } = source("coalescedRequest");
const { applyDiskRefresh, sameGitStatus } = source("workspaceRefresh");
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a burst of 100 refresh triggers runs one active request and one fresh follow-up", async () => {
  const pending = [], received = [];
  const queue = createCoalescedRequest(() => new Promise((resolve) => pending.push(resolve)), (value) => received.push(value));
  queue.request();
  for (let i = 0; i < 100; i++) queue.request();
  assert.equal(pending.length, 1);
  pending[0]("obsolete");
  await tick();
  assert.deepEqual(received, []);
  assert.equal(pending.length, 2);
  pending[1]("current");
  await tick();
  assert.deepEqual(received, ["current"]);
});

test("an old failure cannot replace a newer request and subsequent requests recover", async () => {
  const pending = [], received = [], failures = [];
  const queue = createCoalescedRequest(() => new Promise((resolve, reject) => pending.push({ resolve, reject })), (value) => received.push(value), (error) => failures.push(error));
  queue.request();
  queue.request();
  pending[0].reject("old");
  await tick();
  assert.deepEqual(failures, []);
  pending[1].reject("current");
  await tick();
  assert.deepEqual(failures, ["current"]);
  queue.request();
  pending[2].resolve("recovered");
  await tick();
  assert.deepEqual(received, ["recovered"]);
});

test("disposal suppresses in-flight responses and cancels pending follow-ups", async () => {
  let count = 0, finish;
  const received = [];
  const queue = createCoalescedRequest(() => { count++; return new Promise((resolve) => { finish = resolve; }); }, (value) => received.push(value));
  queue.request();
  queue.request();
  queue.dispose();
  finish("closed workspace");
  await tick();
  queue.request();
  assert.equal(count, 1);
  assert.deepEqual(received, []);
});

const snapshot = { path: "main.ts", name: "main.ts", content: "old", savedContent: "old", revision: 0 };

test("disk refresh updates clean buffers and preserves concurrent unsaved edits", () => {
  const other = { ...snapshot, path: "other.ts" };
  const clean = applyDiskRefresh([snapshot, other], snapshot, "disk edit");
  assert.deepEqual(clean[0], { ...snapshot, content: "disk edit", savedContent: "disk edit", revision: 1 });
  assert.equal(clean[1], other);
  const edited = { ...snapshot, content: "local edit during read" };
  assert.deepEqual(applyDiskRefresh([edited], snapshot, "disk edit")[0], { ...edited, savedContent: "disk edit" });
});

test("stale disk reads cannot undo a newer save or reload or reopen a closed tab", () => {
  const saved = [{ ...snapshot, content: "new saved", savedContent: "new saved" }];
  assert.equal(applyDiskRefresh(saved, snapshot, "stale disk"), saved);
  const reloaded = [{ ...snapshot, revision: 2 }];
  assert.equal(applyDiskRefresh(reloaded, snapshot, "stale disk"), reloaded);
  const closed = [];
  assert.equal(applyDiskRefresh(closed, snapshot, "stale disk"), closed);
  const unchanged = [snapshot];
  assert.equal(applyDiskRefresh(unchanged, snapshot, "old"), unchanged);
});

test("Git equality recognizes unchanged status but detects every visible status change", () => {
  const original = { isRepo: true, branch: "main", changes: [{ path: "main.ts", index: " ", worktree: "M", label: "M", staged: false, untracked: false }], upstream: "origin/main", ahead: 0, behind: 0, merging: false };
  assert.equal(sameGitStatus(original, structuredClone(original)), true);
  for (const [key, value] of Object.entries({ isRepo: false, branch: "other", upstream: null, ahead: 1, behind: 1, merging: true, changes: [] })) {
    assert.equal(sameGitStatus(original, { ...original, [key]: value }), false, key);
  }
  for (const [key, value] of Object.entries({ path: "new.ts", index: "A", worktree: "D", label: "!", staged: true, untracked: true })) {
    assert.equal(sameGitStatus(original, { ...original, changes: [{ ...original.changes[0], [key]: value }] }), false, key);
  }
});
