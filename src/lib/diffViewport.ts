export const DIFF_ROW_HEIGHT = 24;
const OVERSCAN = 16;

/** Keep small diffs intact and bound large diffs to the visible rows plus a buffer. */
export function diffViewport(total: number, scrollTop: number, height: number): { start: number; end: number } {
  if (total <= 200) return { start: 0, end: total };
  const first = Math.max(0, Math.floor(scrollTop / DIFF_ROW_HEIGHT));
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, height)) / DIFF_ROW_HEIGHT);
  return { start: Math.min(total, Math.max(0, first - OVERSCAN)), end: Math.min(total, last + OVERSCAN) };
}
