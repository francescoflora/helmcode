import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/diffMarkers.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { diffMarkers, diffRulerGradient } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const line = (kind) => ({ kind, text: "", oldLine: null, newLine: null });

test("merges contiguous runs of the same kind", () => {
  const markers = diffMarkers([line("context"), line("remove"), line("remove"), line("add"), line("context")]);
  assert.deepEqual(markers, [
    { kind: "remove", start: 1, end: 3 },
    { kind: "add", start: 3, end: 4 },
  ]);
});

test("keeps separated runs apart and ignores context", () => {
  const markers = diffMarkers([line("add"), line("context"), line("add")]);
  assert.deepEqual(markers, [
    { kind: "add", start: 0, end: 1 },
    { kind: "add", start: 2, end: 3 },
  ]);
  assert.deepEqual(diffMarkers([line("context")]), []);
});

test("builds a gradient for each run and none without changes", () => {
  assert.equal(diffRulerGradient([line("context")]), "none");
  const gradient = diffRulerGradient([line("remove"), line("add"), line("context"), line("context")]);
  assert.ok(gradient.startsWith("linear-gradient(to bottom, "));
  assert.ok(gradient.includes("#e99595 0%"));
  assert.ok(gradient.includes("#9bd6bd 25%"));
  assert.ok(gradient.endsWith("transparent 50%)"));
});

test("enforces a minimum marker height without going backwards", () => {
  const lines = Array.from({ length: 1000 }, () => line("context"));
  lines[500] = line("add");
  const stops = [...diffRulerGradient(lines).matchAll(/([\d.]+)%/g)].map((match) => Number(match[1]));
  assert.ok(stops.every((value, index) => index === 0 || value >= stops[index - 1]));
  assert.ok(stops.some((value, index) => index > 0 && value - stops[index - 1] >= 0.79));
});
