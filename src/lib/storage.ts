export function readStored<T>(key: string, fallback: T): T {
  try {
    // Preserve preferences saved before the helmcode rename.
    const legacyKey = key.startsWith("helmcode.") ? key.replace(/^helmcode\./, "devfolio.") : null;
    const raw = window.localStorage.getItem(key) ?? (legacyKey ? window.localStorage.getItem(legacyKey) : null);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage può essere disabilitato: la UI resta utilizzabile */
  }
}
