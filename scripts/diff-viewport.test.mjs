import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/diffViewport.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { diffViewport, DIFF_ROW_HEIGHT } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("small diffs keep every row, including an empty diff", () => {
  assert.deepEqual(diffViewport(0, 0, 500), { start: 0, end: 0 });
  assert.deepEqual(diffViewport(200, 300, 500), { start: 0, end: 200 });
});

test("large diffs retain the viewport and a buffer at the beginning, middle and end", () => {
  for (const top of [0, 100, 120000, 239500]) {
    const range = diffViewport(10000, top, 500);
    assert.ok(range.start <= Math.floor(top / DIFF_ROW_HEIGHT));
    assert.ok(range.end >= Math.min(10000, Math.ceil((top + 500) / DIFF_ROW_HEIGHT)));
    assert.ok(range.end - range.start <= 55);
    assert.ok(range.start >= 0 && range.end <= 10000);
  }
});

test("offscreen and overscrolled containers cannot produce invalid row ranges", () => {
  for (const top of [-100, 0, 999999]) {
    const range = diffViewport(10000, top, 0);
    assert.ok(range.start >= 0 && range.end <= 10000 && range.start <= range.end);
  }
});
