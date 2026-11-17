import type { GitDiffLine } from "../types";

export type HighlightSpan = { from: number; to: number; classes: string };
export type HighlightSegment = { text: string; classes?: string };

type DiffLine = Pick<GitDiffLine, "text" | "oldLine" | "newLine">;

/** Rebuild the full before/after text: the backend returns every line of the file. */
export function reconstructTexts(lines: readonly DiffLine[]): { oldText: string; newText: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of lines) {
    if (line.oldLine !== null) before.push(line.text);
    if (line.newLine !== null) after.push(line.text);
  }
  return { oldText: before.join("\n"), newText: after.join("\n") };
}

/** Split syntax spans into per-line segments; gaps stay plain text. */
export function highlightedLines(text: string, spans: readonly HighlightSpan[]): HighlightSegment[][] {
  const lines = text.split("\n");
  const result: HighlightSegment[][] = [];
  let offset = 0;
  let start = 0;
  for (const line of lines) {
    const segments: HighlightSegment[] = [];
    const end = offset + line.length;
    while (start < spans.length && spans[start].to <= offset) start++;
    let cursor = 0;
    for (let index = start; index < spans.length && spans[index].from < end; index++) {
      const from = Math.max(spans[index].from, offset) - offset;
      const to = Math.min(spans[index].to, end) - offset;
      if (from > cursor) segments.push({ text: line.slice(cursor, from) });
      if (to > from) segments.push({ text: line.slice(from, to), classes: spans[index].classes });
      cursor = Math.max(cursor, to);
    }
    if (cursor < line.length) segments.push({ text: line.slice(cursor) });
    result.push(segments);
    offset = end + 1;
  }
  return result;
}
