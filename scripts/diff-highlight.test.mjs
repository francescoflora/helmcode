import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/diffHighlight.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { highlightedLines, reconstructTexts } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const line = (text, oldLine, newLine) => ({ kind: "context", text, oldLine, newLine });

test("rebuilds both sides from line numbers", () => {
  const { oldText, newText } = reconstructTexts([
    line("a", 1, 1),
    line("b", 2, null),
    line("c", null, 2),
    line("d", 3, 3),
  ]);
  assert.equal(oldText, "a\nb\nd");
  assert.equal(newText, "a\nc\nd");
});

test("maps spans to lines and keeps gaps plain", () => {
  const text = "const x = 1;\nlet y;\n";
  const lines = highlightedLines(text, [{ from: 0, to: 5, classes: "kw" }, { from: 6, to: 7, classes: "name" }]);
  assert.deepEqual(lines[0], [{ text: "const", classes: "kw" }, { text: " " }, { text: "x", classes: "name" }, { text: " = 1;" }]);
  assert.deepEqual(lines[1], [{ text: "let y;" }]);
  assert.deepEqual(lines[2], []);
});

test("splits a span crossing a line break", () => {
  const text = "/* a\nb */";
  const lines = highlightedLines(text, [{ from: 0, to: 9, classes: "comment" }]);
  assert.deepEqual(lines[0], [{ text: "/* a", classes: "comment" }]);
  assert.deepEqual(lines[1], [{ text: "b */", classes: "comment" }]);
});

test("handles empty text and no spans", () => {
  assert.deepEqual(highlightedLines("", []), [[]]);
  assert.deepEqual(highlightedLines("abc", []), [[{ text: "abc" }]]);
});
