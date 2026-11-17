import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/agents.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { AGENTS, agentLabel, isAgentId } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("lists the supported agents with their CLI commands", () => {
  assert.deepEqual(AGENTS.map((agent) => agent.id), ["opencode", "pi", "claude", "agy"]);
  assert.deepEqual(AGENTS.map((agent) => agent.command), ["opencode", "pi", "claude", "agy"]);
});

test("accepts only known agent ids", () => {
  assert.equal(isAgentId("opencode"), true);
  assert.equal(isAgentId("pi"), true);
  assert.equal(isAgentId("claude"), true);
  assert.equal(isAgentId("agy"), true);
  assert.equal(isAgentId("aider"), false);
  assert.equal(isAgentId(null), false);
});

test("uses the display label for the status bar", () => {
  assert.equal(agentLabel("claude"), "Claude Code");
  assert.equal(agentLabel("opencode"), "opencode");
  assert.equal(agentLabel("agy"), "agy");
});
