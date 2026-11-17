import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function loadApi(invoke) {
  const source = readFileSync(new URL("../src/lib/tauri.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("require", "exports", compiled)((name) => {
    if (name === "@tauri-apps/api/core") return { invoke };
    if (name === "@tauri-apps/api/event") return {};
    throw new Error(`Unexpected dependency: ${name}`);
  }, exports);
  return exports.api;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("successive disk saves stay ordered while other documents save independently", async () => {
  const calls = [];
  const pending = [];
  const api = loadApi((_command, args) => {
    calls.push(args);
    return new Promise((resolve, reject) => pending.push({ resolve, reject }));
  });
  const first = api.saveFile("C:/project", "src/main.ts", "first");
  const second = api.saveFile("C:/project", "SRC\\main.ts", "second");
  const other = api.saveFile("C:/project", "README.md", "other");
  await tick();
  assert.deepEqual(calls.map((call) => call.content), ["first", "other"]);
  pending[0].resolve();
  await first;
  await tick();
  assert.deepEqual(calls.map((call) => call.content), ["first", "other", "second"]);
  pending[1].resolve();
  pending[2].resolve();
  await Promise.all([second, other]);
});

test("a failed save rejects its caller and allows the newer snapshot to save", async () => {
  let attempt = 0;
  const api = loadApi(async () => {
    if (++attempt === 1) throw new Error("disk unavailable");
  });
  const first = api.saveFile("C:/project", "main.ts", "first");
  const second = api.saveFile("C:/project", "main.ts", "second");
  await assert.rejects(first, /disk unavailable/);
  await second;
  await api.saveFile("C:/project", "main.ts", "third");
  assert.equal(attempt, 3);
});

test("queued saves retain their original workspace when projects change", async () => {
  const calls = [];
  let finishFirst;
  const api = loadApi((_command, args) => {
    calls.push(args);
    if (calls.length === 1) return new Promise((resolve) => { finishFirst = resolve; });
    return Promise.resolve();
  });
  const first = api.saveFile("C:/project-a", "main.ts", "a1");
  const queued = api.saveFile("C:/project-a", "main.ts", "a2");
  const other = api.saveFile("C:/project-b", "main.ts", "b1");
  await tick();
  assert.deepEqual(calls.map((call) => call.expectedWorkspace), ["C:/project-a", "C:/project-b"]);
  finishFirst();
  await Promise.all([first, queued, other]);
  assert.equal(calls[2].expectedWorkspace, "C:/project-a");
  assert.equal(calls[2].content, "a2");
});

test("replacement waits for queued disk saves to finish", async () => {
  let release;
  let completed = false;
  const api = loadApi(() => new Promise(resolve => { release = resolve; }));
  const save = api.saveFile("C:/project", "main.ts", "new content");
  const flushed = api.flushSaves().then(() => { completed = true; });
  await tick();
  assert.equal(completed, false);
  release();
  await Promise.all([save, flushed]);
  assert.equal(completed, true);
});
