import type { GitDiffLine } from "../types";

export type DiffMarker = { kind: "add" | "remove"; start: number; end: number };

export function diffMarkers(lines: Pick<GitDiffLine, "kind">[]): DiffMarker[] {
  const markers: DiffMarker[] = [];
  lines.forEach((line, index) => {
    if (line.kind === "context") return;
    const last = markers[markers.length - 1];
    if (last && last.kind === line.kind && last.end === index) last.end = index + 1;
    else markers.push({ kind: line.kind, start: index, end: index + 1 });
  });
  return markers;
}

const MARKER_COLORS = { add: "#9bd6bd", remove: "#e99595" } as const;

export function diffRulerGradient(lines: Pick<GitDiffLine, "kind">[], minPercent = 0.8, colors: Record<"add" | "remove", string> = MARKER_COLORS): string {
  const markers = diffMarkers(lines);
  if (markers.length === 0) return "none";
  const total = lines.length || 1;
  const stops = ["transparent 0%"];
  let cursor = 0;
  for (const marker of markers) {
    const start = Math.max(cursor, (marker.start / total) * 100);
    if (start >= 100) break;
    const end = Math.min(100, Math.max(start + minPercent, (marker.end / total) * 100));
    const color = colors[marker.kind];
    stops.push(`transparent ${start}%`, `${color} ${start}%`, `${color} ${end}%`, `transparent ${end}%`);
    cursor = end;
  }
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}
