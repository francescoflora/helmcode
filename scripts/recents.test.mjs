import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/recents.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const recents = {};
new Function("require", "exports", compiled)(() => ({}), recents);

test("recent projects are deduplicated by case-insensitive path and capped", () => {
  const first = { path: "C:\\Projects\\Demo", name: "Demo", modifiedAt: "2026-01-01" };
  const second = { path: "C:/projects/demo", name: "Demo", modifiedAt: "2026-01-02" };
  const list = recents.upsertRecent([first], second);
  assert.equal(list.length, 1);
  assert.equal(list[0].modifiedAt, "2026-01-02");
});

test("newest project stays first while the cap is enforced", () => {
  let list = [];
  for (let index = 0; index < recents.MAX_RECENT + 2; index += 1) {
    list = recents.upsertRecent(list, {
      path: `C:\\Projects\\p${index}`,
      name: `p${index}`,
      modifiedAt: String(index),
    });
  }
  assert.equal(list.length, recents.MAX_RECENT);
  assert.equal(list[0].name, `p${recents.MAX_RECENT + 1}`);
});
