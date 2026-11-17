import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("../src/lib/ptyEvents.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const events = {};
new Function("require", "exports", compiled)((name) => {
  if (name === "@tauri-apps/api/event") return {};
  throw new Error(`Unexpected dependency: ${name}`);
}, events);
const { createSessionEventChannel } = events;
const tick = () => new Promise(setImmediate);

test("100 PTY sessions share one native listener and only the addressed callback runs", async () => {
  let registrations = 0, removals = 0, dispatch;
  const subscribe = createSessionEventChannel(async (handler) => {
    registrations++;
    dispatch = handler;
    return () => removals++;
  });
  const seen = [];
  const cleanup = await Promise.all(Array.from({ length: 100 }, (_, index) => subscribe(`pty-${index}`, (event) => seen.push(event.id))));
  assert.equal(registrations, 1);
  dispatch({ id: "pty-57", data: [65] });
  dispatch({ id: "other-app-session", data: [66] });
  assert.deepEqual(seen, ["pty-57"]);
  cleanup.slice(0, -1).forEach((remove) => remove());
  assert.equal(removals, 0);
  cleanup.at(-1)();
  cleanup.at(-1)();
  assert.equal(removals, 1);
});

test("concurrent subscribers remain attached when an older component unmounts after listen resolves", async () => {
  let dispatch, finishRegistration, removals = 0;
  const subscribe = createSessionEventChannel((handler) => {
    dispatch = handler;
    return new Promise((resolve) => { finishRegistration = () => resolve(() => removals++); });
  });
  const seen = [];
  const first = subscribe("same", () => seen.push("old"));
  const second = subscribe("same", () => seen.push("new"));
  await tick();
  finishRegistration();
  const removeFirst = await first;
  removeFirst();
  const removeSecond = await second;
  assert.equal(removals, 0);
  dispatch({ id: "same" });
  assert.deepEqual(seen, ["new"]);
  removeSecond();
  assert.equal(removals, 1);
});

test("failed registration rejects all waiters, removes stale handlers and allows a fresh retry", async () => {
  let attempt = 0, dispatch;
  const subscribe = createSessionEventChannel(async (handler) => {
    if (++attempt === 1) throw new Error("event transport unavailable");
    dispatch = handler;
    return () => {};
  });
  const seen = [];
  const failures = await Promise.allSettled([
    subscribe("same", () => seen.push("stale-1")),
    subscribe("same", () => seen.push("stale-2")),
  ]);
  assert.ok(failures.every((failure) => failure.status === "rejected"));
  const remove = await subscribe("same", () => seen.push("retry"));
  dispatch({ id: "same" });
  assert.deepEqual(seen, ["retry"]);
  assert.equal(attempt, 2);
  remove();
});

test("events from a detached native registration cannot reach a newly opened terminal", async () => {
  const dispatchers = [];
  let removals = 0;
  const subscribe = createSessionEventChannel(async (dispatch) => {
    dispatchers.push(dispatch);
    return () => removals++;
  });
  const seen = [];
  const old = await subscribe("reopened", () => seen.push("old"));
  old();
  const reopened = await subscribe("reopened", () => seen.push("new"));
  old();
  dispatchers[0]({ id: "reopened" });
  dispatchers[1]({ id: "reopened" });
  assert.deepEqual(seen, ["new"]);
  assert.equal(removals, 1);
  reopened();
  assert.equal(removals, 2);
});
