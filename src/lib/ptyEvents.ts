import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PtyDataPayload, PtyExitPayload } from "../types";

/** Share native PTY events, then dispatch directly to the addressed session. */
export function createSessionEventChannel<T extends { id: string }>(
  register: (dispatch: (payload: T) => void) => Promise<UnlistenFn>,
) {
  type Subscriber = { handler: (payload: T) => void };
  type Connection = { ready: Promise<UnlistenFn> };
  const sessions = new Map<string, Set<Subscriber>>();
  let connection: Connection | undefined;

  const connect = () => {
    if (connection) return connection;
    const next = {} as Connection;
    connection = next;
    next.ready = Promise.resolve().then(() => register((payload) => {
      // An old native listener may still be detaching when a new one connects.
      if (connection !== next) return;
      const subscribers = sessions.get(payload.id);
      if (subscribers) for (const subscriber of [...subscribers]) subscriber.handler(payload);
    })).catch((error: unknown) => {
      if (connection === next) {
        connection = undefined;
        sessions.clear();
      }
      throw error;
    });
    return next;
  };

  return async (id: string, handler: (payload: T) => void): Promise<UnlistenFn> => {
    const subscriber = { handler };
    let subscribers = sessions.get(id);
    if (!subscribers) { subscribers = new Set(); sessions.set(id, subscribers); }
    subscribers.add(subscriber);
    const current = connect();
    const unlisten = await current.ready;
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const subscribers = sessions.get(id);
      subscribers?.delete(subscriber);
      if (subscribers?.size === 0) sessions.delete(id);
      if (sessions.size === 0 && connection === current) {
        connection = undefined;
        unlisten();
      }
    };
  };
}

export const onSessionData = createSessionEventChannel<PtyDataPayload>((dispatch) =>
  listen<PtyDataPayload>("pty-data", (event) => dispatch(event.payload)));

export const onSessionExit = createSessionEventChannel<PtyExitPayload>((dispatch) =>
  listen<PtyExitPayload>("pty-exit", (event) => dispatch(event.payload)));
