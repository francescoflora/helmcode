export type ConflictChoice = "ours" | "theirs" | "both";

export type ConflictSegment =
  | { kind: "context"; lines: string[] }
  | { kind: "conflict"; id: number; ours: string[]; theirs: string[]; base: string[] | null; raw: string[] };

export type ParsedConflicts = {
  segments: ConflictSegment[];
  eol: string;
  count: number;
};

const START = /^<{7,}(?: .*)?$/;
const BASE = /^\|{7,}(?: .*)?$/;
const SEPARATOR = /^={7,}$/;
const END = /^>{7,}(?: .*)?$/;

/** Parse git conflict markers into context and conflict blocks, preserving the line ending style. */
export function parseConflicts(text: string): ParsedConflicts {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const segments: ConflictSegment[] = [];
  let context: string[] = [];
  let index = 0;

  const flushContext = () => {
    if (context.length) {
      segments.push({ kind: "context", lines: context });
      context = [];
    }
  };

  while (index < lines.length) {
    if (!START.test(lines[index])) {
      context.push(lines[index]);
      index += 1;
      continue;
    }
    const raw = [lines[index]];
    index += 1;
    const ours: string[] = [];
    let base: string[] | null = null;
    const theirs: string[] = [];
    let target = ours;
    while (index < lines.length && !END.test(lines[index])) {
      const line = lines[index];
      raw.push(line);
      if (BASE.test(line)) base = [];
      else if (SEPARATOR.test(line)) target = theirs;
      else target.push(line);
      if (base && target === ours) target = base;
      index += 1;
    }
    if (index >= lines.length || !SEPARATOR.test(raw[raw.length - 1] ?? "") && theirs.length === 0) {
      // Malformed block: keep the markers as plain context instead of losing content.
      context.push(...raw);
      if (index < lines.length) { context.push(lines[index]); index += 1; }
      continue;
    }
    raw.push(lines[index]);
    index += 1;
    flushContext();
    segments.push({ kind: "conflict", id: segments.filter((segment) => segment.kind === "conflict").length, ours, theirs, base, raw });
  }
  flushContext();
  return { segments, eol, count: segments.filter((segment) => segment.kind === "conflict").length };
}

/** Rebuild the file text; unresolved blocks keep their original markers so nothing is lost. */
export function resolveConflicts(parsed: ParsedConflicts, choices: Record<number, ConflictChoice>): { text: string; remaining: number } {
  const lines: string[] = [];
  let remaining = 0;
  for (const segment of parsed.segments) {
    if (segment.kind === "context") {
      lines.push(...segment.lines);
      continue;
    }
    const choice = choices[segment.id];
    if (!choice) {
      remaining += 1;
      lines.push(...segment.raw);
      continue;
    }
    if (choice === "ours" || choice === "both") lines.push(...segment.ours);
    if (choice === "theirs" || choice === "both") lines.push(...segment.theirs);
  }
  return { text: lines.join(parsed.eol), remaining };
}
