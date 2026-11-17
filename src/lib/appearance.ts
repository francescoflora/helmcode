import { readStored } from "./storage";

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";
export const THEME_STORAGE_KEY = "helmcode.appearance.theme";
export const THEME_CHANGED_EVENT = "helmcode-theme-changed";
let currentPreference: ThemePreference | undefined;

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "system" ? value : "dark";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export function readThemePreference(): ThemePreference {
  return normalizeThemePreference(readStored<unknown>(THEME_STORAGE_KEY, "dark"));
}

export function getResolvedTheme(): ResolvedTheme {
  const applied = document.documentElement.dataset.theme;
  return applied === "light" || applied === "dark" ? applied
    : resolveTheme(readThemePreference(), window.matchMedia("(prefers-color-scheme: dark)").matches);
}

/** Apply appearance before notifying editors and terminals; keep their sessions intact. */
export function applyTheme(preference = readThemePreference()): ResolvedTheme {
  currentPreference = preference;
  const theme = resolveTheme(preference, window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#ffffff" : "#1e1e1e");
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail: { theme, preference } }));
  return theme;
}

export function subscribeTheme(listener: (theme: ResolvedTheme, preference: ThemePreference) => void): () => void {
  const handler = () => listener(getResolvedTheme(), currentPreference ?? readThemePreference());
  window.addEventListener(THEME_CHANGED_EVENT, handler);
  return () => window.removeEventListener(THEME_CHANGED_EVENT, handler);
}

/** Follow the OS only in System mode, and synchronize appearance across app windows. */
export function startAppearance(): () => void {
  applyTheme();
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystemChange = () => { if (currentPreference === "system") applyTheme(currentPreference); };
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) applyTheme();
  };
  scheme.addEventListener("change", onSystemChange);
  window.addEventListener("storage", onStorage);
  return () => {
    scheme.removeEventListener("change", onSystemChange);
    window.removeEventListener("storage", onStorage);
  };
}
