import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/gitColumns.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { autoFitGitColumns, fitColumn, splitColumnWidth, GIT_COLUMN_BOUNDS } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const measure = (text, mono) => [...text].length * (mono ? 10 : 5);
const commit = (author, shortHash) => ({ author, shortHash });

test("fitColumn clamps to the configured bounds and leaves padding", () => {
  assert.equal(fitColumn([], measure, GIT_COLUMN_BOUNDS.date), GIT_COLUMN_BOUNDS.date.min);
  assert.equal(fitColumn(["x".repeat(100)], measure, GIT_COLUMN_BOUNDS.date), GIT_COLUMN_BOUNDS.date.max);
  assert.equal(fitColumn(["abc"], measure, GIT_COLUMN_BOUNDS.author), GIT_COLUMN_BOUNDS.author.min);
});

test("autoFitGitColumns uses the widest value and the mono hash font", () => {
  const widths = autoFitGitColumns(
    [commit("Ada", "aaaaaaa"), commit("x".repeat(80), "bbbbbbb")],
    ["12 nov 2026, 10:30", "1 dic 2026, 09:00"],
    measure,
  );
  assert.equal(widths.date, Math.min(GIT_COLUMN_BOUNDS.date.max, "12 nov 2026, 10:30".length * 5 + 4));
  assert.equal(widths.author, GIT_COLUMN_BOUNDS.author.max);
  assert.equal(widths.hash, "bbbbbbb".length * 10 + 4);
});

test("splitColumnWidth preserves the pair total and stops at both minimums", () => {
  assert.deepEqual(splitColumnWidth(200, 100, 30, 180, 70), { left: 230, right: 70 });
  assert.deepEqual(splitColumnWidth(200, 100, -30, 180, 70), { left: 180, right: 120 });
  assert.deepEqual(splitColumnWidth(200, 100, 30, 180, 80), { left: 220, right: 80 });
  assert.deepEqual(splitColumnWidth(200, 100, 300, 180, 70), { left: 230, right: 70 });
  assert.equal(splitColumnWidth(200, 100, 30, 180, 70).left + splitColumnWidth(200, 100, 30, 180, 70).right, 300);
});
