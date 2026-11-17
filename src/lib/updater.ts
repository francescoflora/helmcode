import { useCallback, useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { isTauri } from "./tauri";

/** Attivare dopo aver aggiunto la chiave pubblica e i secret di firma. */
export const UPDATER_READY = false;

export type UpdateStatus =
  | "idle"
  | "checking"
  | "none"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export function canAutoUpdate(): boolean {
  return isTauri() && import.meta.env.PROD && UPDATER_READY;
}

export function useUpdater(autoCheck: boolean) {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Update | null>(null);
  const busy = useRef(false);

  const check = useCallback(async (silent = false) => {
    if (!canAutoUpdate() || busy.current) return;
    busy.current = true;
    setStatus("checking");
    setError(null);
    try {
      const { check: checkForUpdate } = await import("@tauri-apps/plugin-updater");
      const update = await checkForUpdate();
      if (update) {
        pending.current = update;
        setStatus("available");
        setVersion(update.version);
      } else {
        pending.current = null;
        setStatus("none");
        setVersion(null);
      }
    } catch (reason) {
      pending.current = null;
      if (silent) {
        setStatus("idle");
      } else {
        setStatus("error");
        setError(String(reason));
      }
    } finally {
      busy.current = false;
    }
  }, []);

  const install = useCallback(async () => {
    const update = pending.current;
    if (!update || busy.current) return;
    busy.current = true;
    setStatus("downloading");
    setProgress(0);
    setError(null);
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          setProgress(total ? 0 : null);
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setProgress(total ? Math.round((downloaded / total) * 100) : null);
        } else if (event.event === "Finished") {
          setProgress(100);
        }
      });
      setStatus("ready");
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (reason) {
      setStatus("error");
      setError(String(reason));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!autoCheck) return;
    void check(true);
  }, [autoCheck, check]);

  return { status, version, progress, error, check, install };
}
