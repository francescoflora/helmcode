import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/conflicts.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { parseConflicts, resolveConflicts } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const block = (ours, theirs, base) => `<<<<<<< HEAD\n${ours}\n${base ? `||||||| base\n${base}\n` : ""}=======\n${theirs}\n>>>>>>> feature\n`;

test("parses context and conflict blocks", () => {
  const text = `before\n${block("current", "incoming")}after\n`;
  const parsed = parseConflicts(text);
  assert.equal(parsed.count, 1);
  assert.deepEqual(parsed.segments[0], { kind: "context", lines: ["before"] });
  assert.deepEqual(parsed.segments[1].ours, ["current"]);
  assert.deepEqual(parsed.segments[1].theirs, ["incoming"]);
  assert.deepEqual(parsed.segments[2], { kind: "context", lines: ["after", ""] });
});

test("resolves ours, theirs and both", () => {
  const parsed = parseConflicts(block("current", "incoming"));
  assert.equal(resolveConflicts(parsed, { 0: "ours" }).text, "current\n");
  assert.equal(resolveConflicts(parsed, { 0: "theirs" }).text, "incoming\n");
  assert.equal(resolveConflicts(parsed, { 0: "both" }).text, "current\nincoming\n");
});

test("keeps unresolved blocks and counts them", () => {
  const text = `before\n${block("current", "incoming")}after\n`;
  const parsed = parseConflicts(text);
  const unresolved = resolveConflicts(parsed, {});
  assert.equal(unresolved.remaining, 1);
  assert.ok(unresolved.text.includes("<<<<<<< HEAD"));
  assert.ok(unresolved.text.endsWith("after\n"));
});

test("handles multiple conflicts and diff3 base sections", () => {
  const text = `${block("a1", "b1")}middle\n${block("a2", "b2", "base2")}`;
  const parsed = parseConflicts(text);
  assert.equal(parsed.count, 2);
  assert.deepEqual(parsed.segments[2].base, ["base2"]);
  const resolved = resolveConflicts(parsed, { 0: "theirs", 1: "ours" });
  assert.equal(resolved.remaining, 0);
  assert.equal(resolved.text, "b1\nmiddle\na2\n");
});

test("preserves CRLF and leaves text without markers untouched", () => {
  const crlf = `before\r\n<<<<<<< HEAD\r\ncurrent\r\n=======\r\nincoming\r\n>>>>>>> feature\r\nafter\r\n`;
  assert.equal(resolveConflicts(parseConflicts(crlf), { 0: "theirs" }).text, "before\r\nincoming\r\nafter\r\n");
  assert.equal(resolveConflicts(parseConflicts("plain\ntext\n"), {}).text, "plain\ntext\n");
});
