import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/gitStatus.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { CHANGE_BADGES, buildChangeMap, changeKind } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const change = (path, label, untracked = false) => ({ path, index: " ", worktree: " ", label, staged: false, untracked });

test("maps Git labels to added, modified and deleted badges", () => {
  assert.equal(changeKind(change("new.txt", "U", true)), "added");
  assert.equal(changeKind(change("staged.txt", "A")), "added");
  assert.equal(changeKind(change("done.txt", "M")), "modified");
  assert.equal(changeKind(change("renamed.txt", "R")), "modified");
  assert.equal(changeKind(change("conflict.txt", "!")), "modified");
  assert.equal(changeKind(change("gone.txt", "D")), "deleted");
  assert.deepEqual(CHANGE_BADGES, { added: "U", modified: "M", deleted: "D" });
});

test("decorates files and ancestor folders with the strongest child status", () => {
  const map = buildChangeMap([
    change("src/components/App.tsx", "M"),
    change("src/new.ts", "U", true),
    change("README.md", "D"),
  ]);
  assert.equal(map.get("src"), "modified");
  assert.equal(map.get("src/components"), "modified");
  assert.equal(map.get("src/components/App.tsx"), "modified");
  assert.equal(map.get("src/new.ts"), "added");
  assert.equal(map.get("README.md"), "deleted");
});

test("explorer map ignores deletions and normalizes Windows separators", () => {
  const map = buildChangeMap([
    change("src\\nested\\changed.ts", "M"),
    change("src\\gone.ts", "D"),
  ], { includeDeleted: false });
  assert.equal(map.get("src/nested/changed.ts"), "modified");
  assert.equal(map.get("src/nested"), "modified");
  assert.equal(map.get("src"), "modified");
  assert.equal(map.has("src/gone.ts"), false);
});
