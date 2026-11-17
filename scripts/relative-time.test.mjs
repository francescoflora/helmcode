import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/relativeTime.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { relativeTime } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const now = Date.parse("2026-11-15T12:00:00Z");
const ago = (milliseconds) => new Date(now - milliseconds).toISOString();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("shows recent changes as adesso", () => {
  assert.equal(relativeTime(ago(30 * SECOND), now), "adesso");
  assert.equal(relativeTime(new Date(now + 20 * SECOND).toISOString(), now), "adesso");
});

test("formats minutes, hours and days", () => {
  assert.equal(relativeTime(ago(5 * MINUTE), now), "5 minuti fa");
  assert.equal(relativeTime(ago(23 * HOUR), now), "23 ore fa");
  assert.equal(relativeTime(ago(1 * DAY), now), "1 giorno fa");
  assert.equal(relativeTime(ago(2 * DAY), now), "2 giorni fa");
});

test("formats months and years", () => {
  assert.equal(relativeTime(ago(60 * DAY), now), "2 mesi fa");
  assert.equal(relativeTime(ago(400 * DAY), now), "1 anno fa");
});

test("handles future, empty and invalid dates", () => {
  assert.equal(relativeTime(new Date(now + 2 * HOUR).toISOString(), now), "tra 2 ore");
  assert.equal(relativeTime("", now), "");
  assert.equal(relativeTime("not-a-date", now), "");
});
