import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Load the parser without a desktop WebView; native transport is intentionally stubbed.
const source = readFileSync(new URL("../src/lib/build.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const build = {};
new Function("require", "exports", compiled)((name) => {
  if (name === "@tauri-apps/api/core" || name === "@tauri-apps/api/event") return {};
  throw new Error(`Unexpected dependency: ${name}`);
}, build);

test("streamed build batches preserve output order, final status and untouched runs", () => {
  const untouched = { id: "old", output: "old output", state: "success" };
  const runs = [untouched, { id: "active", output: "start\n", state: "running" }];
  const merged = build.mergeTaskEvents(runs, [
    { id: "active", kind: "output", stream: "stdout", text: "stdout\n" },
    { id: "unknown", kind: "output", text: "ignored" },
    { id: "active", kind: "output", stream: "stderr", text: "stderr\n" },
    { id: "active", kind: "finished", code: 1 },
  ]);
  assert.equal(merged[0], untouched);
  assert.equal(merged[1].output, "start\nstdout\nstderr\n");
  assert.equal(merged[1].state, "failed");
  assert.equal(merged[1].code, 1);
  assert.equal(runs[1].output, "start\n");
});

test("large output batches retain exactly the newest bounded output and cancellation", () => {
  const events = Array.from({ length: 1000 }, (_, i) => ({ id: "active", kind: "output", text: `${i}\n` }));
  events.push({ id: "active", kind: "finished", cancelled: true, code: null });
  const result = build.mergeTaskEvents([{ id: "active", output: "previous", state: "running" }], events, 80)[0];
  assert.equal(result.output, ("previous" + events.map((event) => event.text ?? "").join("")).slice(-80));
  assert.equal(result.state, "cancelled");
});
const workspace = String.raw`C:\projects\demo`;

test("TypeScript diagnostics retain positions, codes and normalized source paths", () => {
  const result = build.parseBuildDiagnostics("src/App.tsx(42,7): error TS2322: Type 'number' is not assignable to type 'string'.", workspace);
  assert.equal(result.length, 1);
  assert.deepEqual({ ...result[0], message: undefined }, {
    path: "src/App.tsx", line: 42, column: 7, severity: "error", message: undefined,
  });
  assert.match(result[0].message, /TS2322/);
});

test("Rust warnings resolve relative to a nested Tauri manifest", () => {
  const result = build.parseBuildDiagnostics("warning: unused variable: `value`\n  --> src/main.rs:12:9\n   |\n12 | let value = 1;\nwarning: `demo` generated 1 warning", workspace, { id: "cargo:tauri:build" });
  assert.deepEqual(result, [{
    path: "src-tauri/src/main.rs", line: 12, column: 9,
    severity: "warning", message: "unused variable: `value`",
  }]);
});

test("Windows drive letters are preserved for colon-format compiler locations", () => {
  const result = build.parseBuildDiagnostics(String.raw`C:\projects\demo\native\main.cpp:18:3: error: expected ';'`, workspace);
  assert.equal(result[0].path, "native/main.cpp");
  assert.equal(result[0].line, 18);
  assert.equal(result[0].column, 3);
});

test("ANSI styling is removed and duplicate diagnostics collapse", () => {
  const diagnostic = "\u001b[31msrc/main.ts(1,2): error TS1005: ';' expected.\u001b[0m";
  const result = build.parseBuildDiagnostics(`${diagnostic}\n${diagnostic}`, workspace);
  assert.equal(result.length, 1);
  assert.equal(result[0].message, "TS1005: ';' expected.");
});

test("esbuild severity headers attach to the following source location", () => {
  const result = build.parseBuildDiagnostics("✘ [ERROR] Could not resolve import\n\n    src/main.ts:6:4:\n      6 │ import './missing';", workspace);
  assert.equal(result[0].severity, "error");
  assert.equal(result[0].message, "Could not resolve import");
  assert.equal(result[0].line, 6);
  assert.equal(result[0].path, "src/main.ts");
});

test("project-level TypeScript errors remain visible without fake source locations", () => {
  const result = build.parseBuildDiagnostics("error TS18003: No inputs were found in config file.", workspace);
  assert.equal(result[0].path, "");
  assert.equal(result[0].message, "TS18003: No inputs were found in config file.");
});

test("ESLint stylish diagnostics attach to their source file", () => {
  const result = build.parseBuildDiagnostics("/work/demo/src/main.ts\n  2:5  warning  Unexpected console statement  no-console", "/work/demo");
  assert.equal(result[0].path, "src/main.ts");
  assert.equal(result[0].severity, "warning");
  assert.equal(result[0].line, 2);
});

test("files outside the workspace cannot become navigation targets", () => {
  const result = build.parseBuildDiagnostics("../other/src/main.ts(2,3): error TS1005: Missing semicolon", workspace);
  assert.equal(result[0].path, "");
});
