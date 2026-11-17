import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/explorer.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { ancestorDirectories, dropOperations } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("lists ancestor directories for reveal", () => {
  assert.deepEqual(ancestorDirectories("src/components/App.tsx"), ["src", "src/components"]);
  assert.deepEqual(ancestorDirectories("README.md"), []);
  assert.deepEqual(ancestorDirectories("./src\\main.ts"), ["src"]);
});

const entry = (path, isDir = false) => ({ path, name: path.split("/").pop(), isDir, size: 0 });

test("dropping files plans moves into folders or back to the project root", () => {
  assert.deepEqual(dropOperations([entry("src/main.ts"), entry("src/view.ts")], "lib"), [
    { kind: "move", path: "src/main.ts", newPath: "lib/main.ts" },
    { kind: "move", path: "src/view.ts", newPath: "lib/view.ts" },
  ]);
  assert.deepEqual(dropOperations([entry("lib/main.ts")], "."), [{ kind: "move", path: "lib/main.ts", newPath: "main.ts" }]);
  assert.deepEqual(dropOperations([entry("src/main.ts")], "src"), []);
});

test("dropping a selected folder moves its descendants once and rejects invalid destinations", () => {
  assert.deepEqual(dropOperations([entry("src/a", true), entry("src/a/main.ts")], "lib"), [
    { kind: "move", path: "src/a", newPath: "lib/a" },
  ]);
  assert.throws(() => dropOperations([entry("src", true)], "src/nested"), /interno/);
  assert.throws(() => dropOperations([entry("a/main.ts"), entry("b/main.ts")], "lib"), /stesso nome/);
});
