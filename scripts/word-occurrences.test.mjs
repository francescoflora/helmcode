import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/wordOccurrences.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { findWordOccurrences } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const isWord = (char) => /[A-Za-z0-9_]/.test(char);

test("finds whole-word occurrences and marks the cursor word", () => {
  const text = "theme themes other_theme theme Theme";
  const occurrences = findWordOccurrences(text, "theme", isWord, 0);
  assert.deepEqual(occurrences.map(({ from, to, main }) => ({ from, to, main })), [
    { from: 0, to: 5, main: true },
    { from: 25, to: 30, main: false },
  ]);
});

test("keeps matching case-sensitive and handles an empty query", () => {
  assert.equal(findWordOccurrences("Theme theme", "theme", isWord, 0).length, 1);
  assert.deepEqual(findWordOccurrences("anything", "", isWord, 0), []);
});

test("disables highlighting when the match cap is exceeded", () => {
  assert.equal(findWordOccurrences("x x x", "x", isWord, 0, 2).length, 0);
  assert.equal(findWordOccurrences("x x x", "x", isWord, 0, 3).length, 3);
});
