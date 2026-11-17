/** Run one request at a time; repeated triggers retain only one fresh follow-up. */
export function createCoalescedRequest<T>(
  fetch: () => Promise<T>,
  receive: (value: T) => void,
  reject: (error: unknown) => void = () => undefined,
) {
  let running = false;
  let pending = false;
  let disposed = false;
  let generation = 0;

  const run = async () => {
    if (running || disposed) return;
    running = true;
    try {
      while (pending && !disposed) {
        pending = false;
        const requested = generation;
        try {
          const value = await fetch();
          if (!disposed && requested === generation) receive(value);
        } catch (error) {
          if (!disposed && requested === generation) reject(error);
        }
      }
    } finally { running = false; }
  };

  return {
    request() {
      if (disposed) return;
      generation++;
      pending = true;
      void run();
    },
    dispose() {
      disposed = true;
      pending = false;
      generation++;
    },
  };
}
