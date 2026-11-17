import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { isTauri } from "./tauri";
import { readStored, writeStored } from "./storage";

export const START_WINDOW_SIZE = { width: 760, height: 500 };
export const START_MIN_SIZE = { width: 720, height: 460 };
export const APP_WINDOW_SIZE = { width: 1280, height: 800 };
export const APP_MIN_SIZE = { width: 1100, height: 700 };

const APP_WINDOW_SIZE_KEY = "helmcode.window.workspace";

export function normalizeWindowSize(stored: unknown): { width: number; height: number } {
  const entry = (stored && typeof stored === "object" ? stored : {}) as { width?: unknown; height?: unknown };
  const width = typeof entry.width === "number" && Number.isFinite(entry.width) ? entry.width : NaN;
  const height = typeof entry.height === "number" && Number.isFinite(entry.height) ? entry.height : NaN;
  return {
    width: Number.isFinite(width) ? Math.max(APP_MIN_SIZE.width, Math.round(width)) : APP_WINDOW_SIZE.width,
    height: Number.isFinite(height) ? Math.max(APP_MIN_SIZE.height, Math.round(height)) : APP_WINDOW_SIZE.height,
  };
}

export function loadAppWindowSize(): { width: number; height: number } {
  return normalizeWindowSize(readStored<unknown>(APP_WINDOW_SIZE_KEY, null));
}

export type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

export function minimizeWindow(): Promise<void> {
  return getCurrentWindow().minimize();
}

export function toggleMaximizeWindow(): Promise<void> {
  return getCurrentWindow().toggleMaximize();
}

export function closeWindow(): Promise<void> {
  return getCurrentWindow().close();
}

export function startResize(direction: ResizeDirection): Promise<void> {
  return getCurrentWindow().startResizeDragging(direction);
}

export function showWindow(): Promise<void> {
  return getCurrentWindow().show();
}

export async function applyWindowSize(
  width: number,
  height: number,
  minWidth: number,
  minHeight: number,
): Promise<void> {
  if (!isTauri()) return;
  try {
    const window = getCurrentWindow();
    if (await window.isMaximized().catch(() => false)) {
      await window.unmaximize().catch(() => undefined);
    }
    await window.setMinSize(new LogicalSize(minWidth, minHeight));
    await window.setSize(new LogicalSize(width, height));
    await window.center();
  } catch (error) {
    console.warn("Impossibile ridimensionare la finestra", error);
  }
}

export function applyStartWindowSize(): Promise<void> {
  return applyWindowSize(
    START_WINDOW_SIZE.width,
    START_WINDOW_SIZE.height,
    START_MIN_SIZE.width,
    START_MIN_SIZE.height,
  );
}

export function applyAppWindowSize(): Promise<void> {
  const { width, height } = loadAppWindowSize();
  return applyWindowSize(width, height, APP_MIN_SIZE.width, APP_MIN_SIZE.height);
}

export function useWorkspaceWindowSize(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    const appWindow = getCurrentWindow();
    let disposed = false;
    let timer: number | undefined;
    let unlisten: UnlistenFn | undefined;

    const persist = async () => {
      if (disposed || (await appWindow.isMaximized().catch(() => false))) return;
      const scale = await appWindow.scaleFactor().catch(() => 1);
      const size = (await appWindow.innerSize()).toLogical(scale || 1);
      if (!disposed) writeStored(APP_WINDOW_SIZE_KEY, { width: Math.round(size.width), height: Math.round(size.height) });
    };
    const schedule = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => void persist(), 300);
    };

    void appWindow.onResized(schedule).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      unlisten?.();
    };
  }, [enabled]);
}

export function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const window = getCurrentWindow();
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    void window.isMaximized().then((value) => {
      if (!disposed) setMaximized(value);
    });
    void window
      .onResized(() => {
        void window.isMaximized().then((value) => {
          if (!disposed) setMaximized(value);
        });
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return maximized;
}
