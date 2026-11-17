import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { highlightTree } from "@lezer/highlight";
import { StyleModule } from "style-mod";
import type { GitDiffLine } from "../types";
import { diffRulerGradient } from "../lib/diffMarkers";
import { DIFF_ROW_HEIGHT, diffViewport } from "../lib/diffViewport";
import { highlightedLines, reconstructTexts, type HighlightSegment, type HighlightSpan } from "../lib/diffHighlight";
import { getLanguageDescription } from "../lib/languages";
import { helmcodeHighlight } from "../theme";

type Props = { lines: GitDiffLine[]; path: string; scrollKey: string; onScroller?: (element: HTMLElement | null) => void };

if (helmcodeHighlight.module) StyleModule.mount(document, helmcodeHighlight.module);

type SyntaxTree = Parameters<typeof highlightTree>[0];
type Syntax = { path: string; oldText: string; newText: string; old: SyntaxTree; new: SyntaxTree };

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) offsets.push(index + 1);
  return offsets;
}

function highlightRange(tree: SyntaxTree, text: string, offsets: number[], first: number, last: number) {
  const start = offsets[first - 1], end = offsets[last] === undefined ? text.length : offsets[last] - 1;
  const spans: HighlightSpan[] = [];
  highlightTree(tree, helmcodeHighlight, (from, to, classes) => spans.push({ from: Math.max(from, start) - start, to: Math.min(to, end) - start, classes }), start, end);
  return { first, lines: highlightedLines(text.slice(start, end), spans) };
}

export function DiffTable({ lines, path, scrollKey, onScroller }: Props) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastKey = useRef<string | null>(null);
  const attach = useCallback((element: HTMLDivElement | null) => {
    listRef.current = element;
    onScroller?.(element);
  }, [onScroller]);
  const { oldText, newText } = useMemo(() => reconstructTexts(lines), [lines]);
  const offsets = useMemo(() => ({ old: lineOffsets(oldText), new: lineOffsets(newText) }), [oldText, newText]);
  const ruler = useMemo(() => diffRulerGradient(lines, 0.8, { add: "var(--accent)", remove: "var(--danger)" }), [lines]);
  const widestLine = useMemo(() => {
    let widest = "", width = 0;
    for (const line of lines) {
      // Tabs retain their default eight-column width, including in the sizing row.
      let length = line.text.length;
      if (line.text.includes("\t")) {
        length = 0;
        for (const char of line.text) length += char === "\t" ? 8 - length % 8 : 1;
      }
      if (length > width) { widest = line.text; width = length; }
    }
    return widest;
  }, [lines]);
  const [range, setRange] = useState(() => diffViewport(lines.length, 0, 500));
  const start = Math.min(range.start, lines.length), end = Math.min(range.end, lines.length);
  const visible = useMemo(() => lines.slice(start, end), [lines, start, end]);
  const [syntax, setSyntax] = useState<Syntax | null>(null);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = diffViewport(lines.length, list.scrollTop - 12, list.clientHeight);
      setRange((previous) => previous.start === next.start && previous.end === next.end ? previous : next);
    };
    const onScroll = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    const observer = new ResizeObserver(update);
    observer.observe(list);
    list.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => { observer.disconnect(); list.removeEventListener("scroll", onScroll); window.cancelAnimationFrame(frame); };
  }, [lines.length]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const description = getLanguageDescription(path);
    if (!description) return;
    void description.load().then((support) => {
      if (cancelled) return;
      const before = support.language.parser.startParse(oldText);
      const after = oldText === newText ? before : support.language.parser.startParse(newText);
      let oldTree: SyntaxTree | null = null, newTree: SyntaxTree | null = null;
      // Let input and scrolling run between parser slices instead of parsing both files in one task.
      const advance = () => {
        if (cancelled) return;
        try {
          const deadline = performance.now() + 8;
          do {
            if (!oldTree) oldTree = before.advance();
            else if (!newTree) newTree = after === before ? oldTree : after.advance();
            if (oldTree && newTree) { setSyntax({ path, oldText, newText, old: oldTree, new: newTree }); return; }
          } while (performance.now() < deadline);
          timer = window.setTimeout(advance, 0);
        } catch (error) { console.warn(`Sintassi non disponibile per ${path}`, error); }
      };
      timer = window.setTimeout(advance, 0);
    }).catch((error: unknown) => console.warn(`Sintassi non disponibile per ${path}`, error));
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [path, oldText, newText]);

  useLayoutEffect(() => {
    if (lastKey.current === scrollKey) return;
    lastKey.current = scrollKey;
    const index = lines.findIndex((line) => line.kind === "add" || line.kind === "remove");
    const list = listRef.current;
    if (index < 0 || !list) return;
    list.scrollTop = Math.max(0, 12 + (index + 0.5) * DIFF_ROW_HEIGHT - list.clientHeight / 2);
    setRange(diffViewport(lines.length, list.scrollTop - 12, list.clientHeight));
  }, [lines, scrollKey]);

  const highlighted = useMemo(() => {
    if (!syntax || syntax.path !== path || syntax.oldText !== oldText || syntax.newText !== newText) return null;
    const forSide = (side: "old" | "new") => {
      let first = 0, last = 0;
      for (const line of visible) {
        const number = side === "old" ? line.oldLine : line.newLine;
        if (number !== null) { if (!first) first = number; last = number; }
      }
      return first ? highlightRange(syntax[side], side === "old" ? oldText : newText, offsets[side], first, last) : null;
    };
    return { old: forSide("old"), new: forSide("new") };
  }, [syntax, path, oldText, newText, offsets, visible]);

  const segmentsFor = (line: GitDiffLine, side: "old" | "new"): HighlightSegment[] | undefined => {
    const source = highlighted?.[side];
    if (!source) return undefined;
    const number = side === "old" ? line.oldLine : line.newLine;
    return number === null ? undefined : source.lines[number - source.first];
  };
  const render = (text: string, segments: HighlightSegment[] | undefined) => (segments?.length
    ? segments.map((segment, index) => segment.classes
      ? <span key={index} className={segment.classes}>{segment.text}</span>
      : <span key={index}>{segment.text}</span>)
    : text || " ");

  return (
    <div ref={attach} className="scroll-area diff-scroll min-h-0 flex-1 overflow-auto py-3 font-mono text-[13px] leading-6" style={{ "--diff-ruler": ruler, overflowAnchor: "none" } as CSSProperties} tabIndex={0} aria-label="Righe modificate">
      <table className="w-full border-collapse" aria-rowcount={lines.length}><tbody>
        <tr aria-hidden="true" style={{ height: 0, visibility: "hidden" }}><td colSpan={4} style={{ padding: 0, height: 0 }}><div className="whitespace-pre" style={{ height: 0, overflow: "hidden", paddingLeft: 116, paddingRight: 20 }}>{widestLine}</div></td></tr>
        {start > 0 && <tr aria-hidden="true"><td colSpan={4} style={{ height: start * DIFF_ROW_HEIGHT, padding: 0 }} /></tr>}
        {visible.map((line, offset) => <tr key={start + offset} data-index={start + offset} aria-rowindex={start + offset + 1} style={{ height: DIFF_ROW_HEIGHT }} className={line.kind === "add" ? "bg-[var(--diff-added-bg)] text-[var(--diff-added-text)]" : line.kind === "remove" ? "bg-[var(--diff-removed-bg)] text-[var(--diff-removed-text)]" : "text-[var(--secondary)]"}>
        <td className="w-12 select-none px-2 text-right align-top text-xs text-[var(--muted)]">{line.oldLine}</td>
        <td className="w-12 select-none px-2 text-right align-top text-xs text-[var(--muted)]">{line.newLine}</td>
        <td className="w-5 select-none text-center align-top" aria-label={line.kind === "add" ? "Aggiunta" : line.kind === "remove" ? "Eliminata" : undefined}>{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</td>
        <td className="whitespace-pre pr-5 align-top">{render(line.text, segmentsFor(line, line.kind === "remove" ? "old" : "new"))}</td>
      </tr>)}
        {end < lines.length && <tr aria-hidden="true"><td colSpan={4} style={{ height: (lines.length - end) * DIFF_ROW_HEIGHT, padding: 0 }} /></tr>}
      </tbody></table>
    </div>
  );
}
