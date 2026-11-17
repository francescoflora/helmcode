import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/buildDefaults.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { defaultsFor, resolveDefaultTask, withDefault, workspaceKey } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const build = { id: "npm:build", label: "build", command: "npm run build", group: "npm", kind: "build" };
const buildProd = { id: "npm:build:prod", label: "build:prod", command: "npm run build:prod", group: "npm", kind: "build" };
const play = { id: "npm:dev", label: "dev", command: "npm run dev", group: "npm", kind: "play" };
const tasks = [build, buildProd, play];

test("normalizes workspace keys", () => {
  assert.equal(workspaceKey("C:\\Projects\\helmcode\\"), "C:/Projects/helmcode");
  assert.equal(workspaceKey("/home/me/app/"), "/home/me/app");
});

test("stores defaults per workspace and kind", () => {
  const store = withDefault(withDefault({}, "C:\\app", "build", "npm:build:prod"), "C:\\app", "play", "npm:dev");
  assert.deepEqual(defaultsFor(store, "C:/app/"), { build: "npm:build:prod", play: "npm:dev" });
  assert.deepEqual(defaultsFor(store, "C:/other"), {});
});

test("uses the stored task, then the detected fallback, then the first task of the kind", () => {
  assert.equal(resolveDefaultTask(tasks, "build", "npm:build:prod", build), buildProd);
  assert.equal(resolveDefaultTask(tasks, "build", "missing", build), build);
  assert.equal(resolveDefaultTask([buildProd, build], "build", undefined, null), buildProd);
  assert.equal(resolveDefaultTask([], "play", undefined, play), null);
});
