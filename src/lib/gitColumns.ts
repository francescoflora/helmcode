import type { GitCommit } from "../types";

export const DESCRIPTION_MIN_WIDTH = 180;

export const GIT_COLUMN_BOUNDS = {
  date: { min: 90, max: 170 },
  author: { min: 80, max: 200 },
  hash: { min: 70, max: 96 },
} as const;

export type GitColumnWidths = { date: number; author: number; hash: number };
export type ColumnBounds = { min: number; max: number };
export type TextMeasure = (text: string, mono?: boolean) => number;

export function fitColumn(texts: string[], measure: TextMeasure, bounds: ColumnBounds, mono = false): number {
  let widest = 0;
  for (const text of texts) widest = Math.max(widest, measure(text, mono));
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, widest + 4)));
}

export function autoFitGitColumns(
  commits: Pick<GitCommit, "author" | "shortHash">[],
  dates: string[],
  measure: TextMeasure,
): GitColumnWidths {
  return {
    date: fitColumn(["Data", ...dates], measure, GIT_COLUMN_BOUNDS.date),
    author: fitColumn(["Autore", ...commits.map((commit) => commit.author)], measure, GIT_COLUMN_BOUNDS.author),
    hash: fitColumn(["Commit", ...commits.map((commit) => commit.shortHash)], measure, GIT_COLUMN_BOUNDS.hash, true),
  };
}

/** Resize one column independently, clamping only to its own minimum width. */
export function resizeColumnWidth(width: number, delta: number, minWidth: number): number {
  return Math.max(minWidth, Math.round(width + delta));
}
