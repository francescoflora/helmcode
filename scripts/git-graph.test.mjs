import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/gitGraph.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { GRAPH_COLORS, laneColor, layoutCommitGraph } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const commit = (hash, parents, subject = hash) => ({ hash, shortHash: hash, parents, author: "Test", email: "test@example.test", date: "2026-11-12T10:00:00+01:00", subject, refs: [] });

test("linear history keeps a single lane and connects each parent", () => {
  const layout = layoutCommitGraph([commit("a", ["b"]), commit("b", ["c"]), commit("c", [])]);
  assert.equal(layout.lanes, 1);
  assert.deepEqual(layout.rows.map((row) => row.column), [0, 0, 0]);
  assert.deepEqual(layout.rows[0].edges, [{ from: 0, to: 0 }]);
  assert.deepEqual(layout.rows[2].edges, []);
  assert.deepEqual(layout.rows[2].end, []);
});

test("merge commits branch into two lanes and converge on the shared parent", () => {
  const layout = layoutCommitGraph([commit("merge", ["main", "feature"]), commit("main", ["base"]), commit("feature", ["base"]), commit("base", [])]);
  assert.equal(layout.lanes, 2);
  assert.equal(layout.rows[0].column, 0);
  assert.deepEqual(layout.rows[0].edges, [{ from: 0, to: 0 }, { from: 0, to: 1 }]);
  assert.deepEqual(layout.rows[0].end, ["main", "feature"]);
  assert.equal(layout.rows[2].column, 1);
  assert.deepEqual(layout.rows[2].edges, [{ from: 1, to: 0 }]);
  assert.deepEqual(layout.rows[2].end, ["base"]);
  assert.deepEqual(layout.rows[3].end, []);
});

test("new branch tips reuse free lanes and missing parents leave a dangling lane", () => {
  const layout = layoutCommitGraph([commit("tip", ["missing"])]);
  assert.equal(layout.lanes, 1);
  assert.deepEqual(layout.rows[0].start, []);
  assert.deepEqual(layout.rows[0].end, ["missing"]);
  assert.deepEqual(layout.rows[0].edges, [{ from: 0, to: 0 }]);
});

test("lane colors provide twelve distinct values and repeat after the palette", () => {
  assert.equal(GRAPH_COLORS.length, 12);
  assert.equal(new Set(GRAPH_COLORS).size, 12);
  assert.equal(laneColor(12), laneColor(0));
  assert.notEqual(laneColor(0), laneColor(1));
});
