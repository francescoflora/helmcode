import { useEffect, useSyncExternalStore } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { isTauri } from "./tauri";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "none"
  | "available"
  | "downloading"
  | "ready"
  | "error";

type UpdateState = {
  status: UpdateStatus;
  version: string | null;
  progress: number | null;
  error: string | null;
};

const INITIAL_STATE: UpdateState = { status: "idle", version: null, progress: null, error: null };

/** Kept outside React: the Tauri Update handle is not serializable. */
let pending: Update | null = null;
let busy = false;
/** Automatic checks run once per app session. */
let autoChecked = false;

let state = INITIAL_STATE;
const listeners = new Set<() => void>();

function setState(patch: Partial<UpdateState>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

export function canAutoUpdate(): boolean {
  return isTauri() && import.meta.env.PROD;
}

async function check(silent = false) {
  if (!canAutoUpdate() || busy) return;
  busy = true;
  setState({ status: "checking", error: null });
  try {
    const { check: checkForUpdate } = await import("@tauri-apps/plugin-updater");
    const update = await checkForUpdate();
    if (update) {
      pending = update;
      setState({ status: "available", version: update.version });
    } else {
      pending = null;
      setState({ status: "none", version: null });
    }
  } catch (reason) {
    pending = null;
    if (silent) {
      setState({ status: "idle", version: null, error: null });
    } else {
      setState({ status: "error", error: String(reason) });
    }
  } finally {
    busy = false;
  }
}

async function install() {
  const update = pending;
  if (!update || busy) return;
  busy = true;
  setState({ status: "downloading", progress: 0, error: null });
  try {
    let downloaded = 0;
    let total = 0;
    await update.download((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
        setState({ progress: total ? 0 : null });
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        setState({ progress: total ? Math.min(100, Math.round((downloaded / total) * 100)) : null });
      } else if (event.event === "Finished") {
        setState({ progress: 100 });
      }
    });
    setState({ status: "ready", progress: 100 });
    // Let the webview paint 100% before install exits the app on Windows.
    await new Promise((resolve) => setTimeout(resolve, 800));
    // Windows: launches the NSIS installer and exits; the installer restarts the app.
    await update.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (reason) {
    setState({ status: "error", error: String(reason) });
  } finally {
    busy = false;
  }
}

export function useUpdater(autoCheck: boolean) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!autoCheck || autoChecked) return;
    autoChecked = true;
    void check(true);
  }, [autoCheck]);

  return { ...snapshot, check, install };
}
