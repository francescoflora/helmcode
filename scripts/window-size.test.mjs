import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/window.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const stubs = {
  "@tauri-apps/api/dpi": { LogicalSize: class {} },
  "@tauri-apps/api/window": { getCurrentWindow: () => ({}) },
  react: { useEffect: () => {}, useState: () => [false, () => {}] },
  "./tauri": { isTauri: () => false },
  "./storage": { readStored: () => null, writeStored: () => {} },
};
const windowLib = {};
new Function("require", "exports", compiled)((id) => stubs[id], windowLib);

test("invalid or missing workspace size falls back to the default", () => {
  assert.deepEqual(windowLib.normalizeWindowSize(null), windowLib.APP_WINDOW_SIZE);
  assert.deepEqual(windowLib.normalizeWindowSize({ width: "wide", height: NaN }), windowLib.APP_WINDOW_SIZE);
  assert.deepEqual(windowLib.normalizeWindowSize({ width: Infinity, height: 900 }), { width: 1280, height: 900 });
});

test("workspace size is clamped to the minimum and rounded", () => {
  assert.deepEqual(windowLib.normalizeWindowSize({ width: 900, height: 600 }), windowLib.APP_MIN_SIZE);
  assert.deepEqual(windowLib.normalizeWindowSize({ width: 1600.4, height: 900.6 }), { width: 1600, height: 901 });
});
