type Size = { rows: number; cols: number };

/** Keep writes ordered and allow only the latest pending resize per session. */
export function createTerminalTransport(
  write: (data: string) => Promise<unknown>,
  resize: (rows: number, cols: number) => Promise<unknown>,
) {
  let ready = false;
  let disposed = false;
  let writing = false;
  let resizing = false;
  let pendingWrite = "";
  let pendingSize: Size | null = null;
  let lastSize: Size | null = null;

  const flushWrites = async () => {
    if (!ready || disposed || writing) return;
    writing = true;
    try {
      while (!disposed && pendingWrite) {
        const data = pendingWrite;
        pendingWrite = "";
        try { await write(data); } catch { /* A closed PTY may reject input. */ }
      }
    } finally { writing = false; }
  };
  const flushSizes = async () => {
    if (!ready || disposed || resizing) return;
    resizing = true;
    try {
      while (!disposed && pendingSize) {
        const size = pendingSize;
        pendingSize = null;
        if (lastSize?.rows === size.rows && lastSize.cols === size.cols) continue;
        try {
          await resize(size.rows, size.cols);
          lastSize = size;
        } catch { /* A closed PTY may reject a resize. */ }
      }
    } finally { resizing = false; }
  };

  return {
    start(rows: number, cols: number) {
      if (disposed) return;
      lastSize = { rows, cols };
      ready = true;
      void flushWrites();
      void flushSizes();
    },
    write(data: string) {
      if (disposed) return;
      pendingWrite += data;
      void flushWrites();
    },
    resize(rows: number, cols: number) {
      if (disposed) return;
      pendingSize = { rows, cols };
      void flushSizes();
    },
    dispose() {
      disposed = true;
      pendingWrite = "";
      pendingSize = null;
    },
  };
}
