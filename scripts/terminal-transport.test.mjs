import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/terminalTransport.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createTerminalTransport } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const tick = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("terminal input waits for creation, stays ordered and coalesces pending chunks", async () => {
  const calls = [];
  const first = deferred();
  const second = deferred();
  const transport = createTerminalTransport((data) => {
    calls.push(data);
    return calls.length === 1 ? first.promise : second.promise;
  }, async () => {});
  transport.write("a");
  assert.deepEqual(calls, []);
  transport.start(24, 80);
  transport.write("b");
  transport.write("😀\r");
  assert.deepEqual(calls, ["a"]);
  first.resolve();
  await tick();
  assert.deepEqual(calls, ["a", "b😀\r"]);
  transport.write("discarded after close");
  transport.dispose();
  second.resolve();
  await tick();
  transport.write("closed");
  assert.deepEqual(calls, ["a", "b😀\r"]);
});

test("terminal resize skips existing dimensions and only sends the latest pending size", async () => {
  const calls = [];
  const first = deferred();
  const transport = createTerminalTransport(async () => {}, (rows, cols) => {
    calls.push([rows, cols]);
    return calls.length === 1 ? first.promise : Promise.resolve();
  });
  transport.resize(24, 80);
  transport.start(24, 80);
  assert.deepEqual(calls, []);
  transport.resize(25, 80);
  for (let cols = 81; cols <= 120; cols++) transport.resize(30, cols);
  assert.deepEqual(calls, [[25, 80]]);
  first.resolve();
  await tick();
  assert.deepEqual(calls, [[25, 80], [30, 120]]);
  transport.resize(30, 120);
  await tick();
  assert.equal(calls.length, 2);
  transport.dispose();
  transport.resize(99, 99);
  assert.equal(calls.length, 2);
});

test("a rejected write does not block subsequent input", async () => {
  const calls = [];
  const transport = createTerminalTransport(async (data) => {
    calls.push(data);
    if (calls.length === 1) throw new Error("closed pipe");
  }, async () => {});
  transport.start(24, 80);
  transport.write("first");
  transport.write("second");
  await tick();
  assert.deepEqual(calls, ["first", "second"]);
  transport.dispose();
});

test("disposing a failed or already exited startup drops queued input and resize requests", async () => {
  const writes = [], sizes = [];
  const transport = createTerminalTransport(async (data) => writes.push(data), async (rows, cols) => sizes.push([rows, cols]));
  transport.write("typed while startup was pending");
  transport.resize(24, 80);
  transport.dispose();
  transport.start(24, 80);
  transport.write("typed after failure");
  transport.resize(30, 100);
  await tick();
  assert.deepEqual(writes, []);
  assert.deepEqual(sizes, []);
});
