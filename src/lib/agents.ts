import type { AgentId } from "../types";

export type AgentInfo = { id: AgentId; label: string; command: string };

export const AGENTS: readonly AgentInfo[] = [
  { id: "opencode", label: "opencode", command: "opencode" },
  { id: "pi", label: "pi", command: "pi" },
  { id: "claude", label: "Claude Code", command: "claude" },
  { id: "agy", label: "agy", command: "agy" },
];

export function isAgentId(value: unknown): value is AgentId {
  return AGENTS.some((agent) => agent.id === value);
}

export function agentLabel(id: AgentId): string {
  return AGENTS.find((agent) => agent.id === id)?.label ?? id;
}
