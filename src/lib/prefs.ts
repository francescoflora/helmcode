import { readStored, writeStored } from "./storage";
import { isAgentId } from "./agents";
import { readThemePreference, THEME_STORAGE_KEY, type ThemePreference } from "./appearance";
import type { AgentId, WorkspaceMode } from "../types";

export interface Prefs {
  theme: ThemePreference;
  showSplash: boolean;
  autoOpenLast: boolean;
  autoCheckUpdates: boolean;
  startMode: WorkspaceMode;
  agent: AgentId;
}

export const DEFAULT_PREFS: Prefs = {
  theme: "dark",
  showSplash: true,
  autoOpenLast: false,
  autoCheckUpdates: true,
  startMode: "ai",
  agent: "opencode",
};

const KEYS = {
  theme: THEME_STORAGE_KEY,
  showSplash: "helmcode.start.splash",
  autoOpenLast: "helmcode.start.autoOpen",
  autoCheckUpdates: "helmcode.updates.auto",
  startMode: "helmcode.mode",
  agent: "helmcode.agent",
} as const;

const STORAGE_KEYS: Record<keyof Prefs, string> = KEYS;

export function loadPrefs(): Prefs {
  const agent = readStored<string>(KEYS.agent, DEFAULT_PREFS.agent);
  return {
    theme: readThemePreference(),
    showSplash: readStored<boolean>(KEYS.showSplash, DEFAULT_PREFS.showSplash),
    autoOpenLast: readStored<boolean>(KEYS.autoOpenLast, DEFAULT_PREFS.autoOpenLast),
    autoCheckUpdates: readStored<boolean>(KEYS.autoCheckUpdates, DEFAULT_PREFS.autoCheckUpdates),
    startMode: readStored<string>(KEYS.startMode, DEFAULT_PREFS.startMode) === "ide" ? "ide" : "ai",
    agent: isAgentId(agent) ? agent : DEFAULT_PREFS.agent,
  };
}

export function savePref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  writeStored(STORAGE_KEYS[key], value);
}

export function resetPrefs(): Prefs {
  Object.values(KEYS).forEach((key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  });
  return { ...DEFAULT_PREFS };
}
