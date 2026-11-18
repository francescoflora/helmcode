import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { autoFitGitColumns, DESCRIPTION_MIN_WIDTH, GIT_COLUMN_BOUNDS, splitColumnWidth } from "../lib/gitColumns";
import { graphColumnWidth, LANE_WIDTH, layoutCommitGraph, laneColor, type GraphRow } from "../lib/gitGraph";
import { api } from "../lib/tauri";
import type { GitCommitFile, GitLog } from "../types";
import { CommitDiff } from "./CommitDiff";
import { FileTypeIcon } from "./FileTypeIcon";
import { CloudIcon, GitBranchIcon, RefreshIcon, TagIcon, TargetIcon } from "./Icons";

const PAGE_SIZE = 300;
const MAX_COMMITS = 2000;
const ROW_HEIGHT = 30;
const laneStroke = (lane: number) => `var(--git-lane-${lane % 12}, ${laneColor(lane)})`;
type Props = { workspace: string; version: number; onCherryPick: (hash: string) => void | Promise<void> };
type SelectedFile = { hash: string; shortHash: string; path: string; oldPath: string | null };
type RefKind = "head" | "local" | "remote" | "tag";
type CommitMenu = { hash: string; shortHash: string; x: number; y: number };
type ColumnHandle = "graph" | "description" | "date" | "author";
type CustomWidths = { graph?: number; date?: number; author?: number; hash?: number };
type DragState = { handle: ColumnHandle; startX: number; left: number; right: number };

const SANS_FONT = '11px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
const MONO_FONT = '11px "Cascadia Code", "Consolas", ui-monospace, monospace';
// Column widths last for the app session, even when the Git view is unmounted.
let sessionWidths: CustomWidths = {};
let measureContext: CanvasRenderingContext2D | null | undefined;

function measureText(text: string, mono = false): number {
  if (measureContext === undefined) measureContext = document.createElement("canvas").getContext("2d");
  if (!measureContext) return text.length * 7;
  measureContext.font = mono ? MONO_FONT : SANS_FONT;
  return measureContext.measureText(text).width;
}

const shortDate = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium", timeStyle: "short" });
const longDate = new Intl.DateTimeFormat("it-IT", { dateStyle: "full", timeStyle: "long" });

function dateLabel(value: string, full = false): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : (full ? longDate : shortDate).format(date);
}

function refLabel(value: string, remotes: string[]): { label: string; kind: RefKind } {
  if (value.startsWith("HEAD -> ")) return { label: value.slice(8), kind: "head" };
  if (value.startsWith("tag: ")) return { label: value.slice(5), kind: "tag" };
  if (remotes.some((remote) => value.startsWith(`${remote}/`))) return { label: value, kind: "remote" };
  return { label: value, kind: "local" };
}

function RefIcon({ kind }: { kind: RefKind }) {
  const className = "git-ref-icon";
  if (kind === "head") return <TargetIcon className={className} />;
  if (kind === "remote") return <CloudIcon className={className} />;
  if (kind === "tag") return <TagIcon className={className} />;
  return <GitBranchIcon className={className} />;
}

export function GitHistory({ workspace, version, onCherryPick }: Props) {
  const [log, setLog] = useState<GitLog | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [files, setFiles] = useState<GitCommitFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const [menu, setMenu] = useState<CommitMenu | null>(null);
  const [customWidths, setCustomWidths] = useState<CustomWidths>(() => sessionWidths);
  const filesRequest = useRef(0);
  const drag = useRef<DragState | null>(null);
  const descriptionRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    sessionWidths = customWidths;
  }, [customWidths]);

  useEffect(() => () => { document.body.classList.remove("resizing"); }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.gitLog(workspace, limit)
      .then((value) => { if (!cancelled) setLog(value); })
      .catch((reason: unknown) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspace, version, limit, reload]);

  useEffect(() => {
    if (!menu) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenu(null);
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [menu]);

  const layout = useMemo(() => layoutCommitGraph(log?.commits ?? []), [log]);
  const autoWidths = useMemo(() => autoFitGitColumns(
    layout.rows.map((row) => row.commit),
    layout.rows.map((row) => dateLabel(row.commit.date)),
    measureText,
  ), [layout]);
  const autoGraphWidth = graphColumnWidth(layout.lanes);
  const graphWidth = Math.max(autoGraphWidth, customWidths.graph ?? 0);
  const dateWidth = customWidths.date ?? autoWidths.date;
  const authorWidth = customWidths.author ?? autoWidths.author;
  const hashWidth = customWidths.hash ?? autoWidths.hash;
  const tableStyle = {
    "--git-graph-width": `${graphWidth}px`,
    "--git-description-min": `${DESCRIPTION_MIN_WIDTH}px`,
    "--git-date-width": `${dateWidth}px`,
    "--git-author-width": `${authorWidth}px`,
    "--git-hash-width": `${hashWidth}px`,
  } as CSSProperties;
  const commitCount = log?.commits.length ?? 0;

  const descriptionWidth = () => descriptionRef.current?.getBoundingClientRect().width ?? 0;

  function currentStart(handle: ColumnHandle): { left: number; right: number } {
    const description = descriptionWidth();
    if (handle === "graph") return { left: graphWidth, right: description };
    if (handle === "description") return { left: description, right: dateWidth };
    if (handle === "date") return { left: dateWidth, right: authorWidth };
    return { left: authorWidth, right: hashWidth };
  }

  function applyResize(handle: ColumnHandle, delta: number, start: { left: number; right: number }): CustomWidths | null {
    if (start.left <= 0 || start.right <= 0) return null;
    if (handle === "graph") {
      const result = splitColumnWidth(start.left, start.right, delta, autoGraphWidth, DESCRIPTION_MIN_WIDTH);
      return { graph: result.left };
    }
    if (handle === "description") {
      const result = splitColumnWidth(start.left, start.right, delta, DESCRIPTION_MIN_WIDTH, GIT_COLUMN_BOUNDS.date.min);
      return { date: result.right };
    }
    if (handle === "date") {
      const result = splitColumnWidth(start.left, start.right, delta, GIT_COLUMN_BOUNDS.date.min, GIT_COLUMN_BOUNDS.author.min);
      return { date: result.left, author: result.right };
    }
    const result = splitColumnWidth(start.left, start.right, delta, GIT_COLUMN_BOUNDS.author.min, GIT_COLUMN_BOUNDS.hash.min);
    return { author: result.left, hash: result.right };
  }

  function resizeBy(handle: ColumnHandle, delta: number) {
    const patch = applyResize(handle, delta, currentStart(handle));
    if (patch) setCustomWidths((current) => ({ ...current, ...patch }));
  }

  function beginResize(event: ReactPointerEvent<HTMLSpanElement>, handle: ColumnHandle) {
    if (event.button !== 0) return;
    const start = currentStart(handle);
    if (start.left <= 0 || start.right <= 0) return;
    drag.current = { handle, startX: event.clientX, ...start };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    document.body.classList.add("resizing");
  }

  function moveResize(event: ReactPointerEvent<HTMLSpanElement>) {
    const state = drag.current;
    if (!state) return;
    const patch = applyResize(state.handle, event.clientX - state.startX, state);
    if (patch) setCustomWidths((current) => ({ ...current, ...patch }));
  }

  function endResize(event: ReactPointerEvent<HTMLSpanElement>) {
    if (!drag.current) return;
    drag.current = null;
    document.body.classList.remove("resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  const resizer = (handle: ColumnHandle, label: string) => (
    <span role="separator" aria-orientation="vertical" aria-label={label} title={`${label} · doppio click per autofit`} tabIndex={0}
      className="git-col-resizer"
      onPointerDown={(event) => beginResize(event, handle)}
      onPointerMove={moveResize}
      onPointerUp={endResize}
      onPointerCancel={endResize}
      onLostPointerCapture={() => { drag.current = null; document.body.classList.remove("resizing"); }}
      onDoubleClick={(event) => { event.preventDefault(); setCustomWidths({}); }}
      onKeyDown={(event: ReactKeyboardEvent<HTMLSpanElement>) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        resizeBy(handle, event.key === "ArrowLeft" ? -16 : 16);
      }} />
  );

  function toggleCommit(row: GraphRow) {
    const { hash } = row.commit;
    if (expanded === hash) {
      setExpanded(null);
      return;
    }
    setExpanded(hash);
    setFiles(null);
    setFilesError(null);
    setFilesLoading(true);
    const request = ++filesRequest.current;
    api.gitCommitFiles(workspace, hash)
      .then((result) => { if (request === filesRequest.current) setFiles(result); })
      .catch((reason: unknown) => { if (request === filesRequest.current) setFilesError(String(reason)); })
      .finally(() => { if (request === filesRequest.current) setFilesLoading(false); });
  }

  return <section className="git-history" role="region" aria-label="Grafo Git">
    <header className="git-history-header">
      <GitBranchIcon className="h-4.5 w-4.5 text-[var(--accent)]" />
      <span className="git-history-title">Grafo dei commit</span>
      <span className="git-history-count">{commitCount} commit · tutti i branch e tag</span>
      <button type="button" className="icon-button ml-auto" onClick={() => setReload((value) => value + 1)} aria-label="Ricarica grafo Git" title="Ricarica grafo Git">
        <RefreshIcon className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
      </button>
    </header>
    {error && <div role="alert" className="git-history-error">{error}</div>}
    {selected ? <CommitDiff key={`${selected.hash}:${selected.path}`} workspace={workspace} hash={selected.hash} shortHash={selected.shortHash} path={selected.path} oldPath={selected.oldPath} onBack={() => setSelected(null)} />
      : loading && !log ? <div className="git-history-empty" role="status">Lettura cronologia Git…</div>
      : !log || commitCount === 0 ? <div className="git-history-empty">Nessun commit da mostrare.</div>
      : <div className="scroll-area git-history-list" tabIndex={0} aria-label="Commit del repository">
        <div className="git-history-table" role="table" style={tableStyle}>
          <div className="git-history-table-header" role="row">
            <span role="columnheader">Grafo{resizer("graph", "Ridimensiona la colonna Grafo")}</span>
            <span role="columnheader" ref={descriptionRef}>Descrizione{resizer("description", "Ridimensiona la colonna Descrizione")}</span>
            <span role="columnheader">Data{resizer("date", "Ridimensiona la colonna Data")}</span>
            <span role="columnheader">Autore{resizer("author", "Ridimensiona la colonna Autore")}</span>
            <span role="columnheader">Commit</span>
          </div>
          {layout.rows.map((row) => <Fragment key={row.commit.hash}>
            <CommitRow row={row} width={graphWidth} remotes={log?.remotes ?? []} expanded={expanded === row.commit.hash}
              onSelect={() => toggleCommit(row)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ hash: row.commit.hash, shortHash: row.commit.shortHash, x: event.clientX, y: event.clientY });
              }} />
            {expanded === row.commit.hash && <div className="git-commit-files" role="region" aria-label="File modificati dal commit">
              {filesLoading ? <div className="git-commit-files-state" role="status">Lettura file del commit…</div>
                : filesError ? <div role="alert" className="git-commit-files-state is-error">{filesError}</div>
                : !files || files.length === 0 ? <div className="git-commit-files-state">Nessun file modificato in questo commit.</div>
                : files.map((file) => <button type="button" key={file.path} className="git-commit-file" onClick={() => setSelected({ hash: row.commit.hash, shortHash: row.commit.shortHash, path: file.path, oldPath: file.oldPath })} title={`Confronta ${file.path} con il commit precedente`}>
                  <span className={`git-commit-file-status is-${file.status.toLowerCase()}`}>{file.status}</span>
                  <FileTypeIcon path={file.path} className="h-[16px] w-[16px] shrink-0" />
                  <span className="git-commit-file-path">{file.path}</span>
                  {file.oldPath && <span className="git-commit-file-old">{file.oldPath}</span>}
                </button>)}
            </div>}
          </Fragment>)}
        </div>
      </div>}
    {!selected && log?.truncated && <div className="git-history-more">
      <button type="button" disabled={loading} onClick={() => setLimit((value) => Math.min(MAX_COMMITS, value + PAGE_SIZE))}>Carica altri commit</button>
    </div>}
    {menu && <>
      <div className="commit-context-backdrop" onClick={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }} />
      <div className="explorer-context-menu" role="menu" aria-label={`Azioni per il commit ${menu.shortHash}`} style={{ left: menu.x, top: menu.y }}>
        <button type="button" role="menuitem" onClick={() => { const hash = menu.hash; setMenu(null); void onCherryPick(hash); }}>
          <GitBranchIcon className="h-4 w-4" />
          <span>Cherry-pick sul branch corrente</span>
        </button>
      </div>
    </>}
  </section>;
}

function CommitRow({ row, width, remotes, expanded, onSelect, onContextMenu }: {
  row: GraphRow; width: number; remotes: string[]; expanded: boolean; onSelect: () => void;
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  const { commit } = row;
  return <div className={`git-history-row ${expanded ? "is-expanded" : ""}`} role="row" tabIndex={0} aria-expanded={expanded}
    onClick={onSelect}
    onContextMenu={onContextMenu}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }}
    title={`${commit.hash}\n${commit.author} <${commit.email}>\n${dateLabel(commit.date, true)}`}>
    <span className="git-history-graph" role="cell"><GraphCell row={row} width={width} /></span>
    <span className="git-history-description" role="cell">
      <span className="git-history-subject-text">{commit.subject}</span>
      {commit.refs.map((value) => {
        const ref = refLabel(value, remotes);
        return <span key={value} className={`git-ref is-${ref.kind}`} title={ref.label}><RefIcon kind={ref.kind} /><span>{ref.label}</span></span>;
      })}
      {commit.unpushed && <span className="git-ref is-unpushed" title="Commit locale non ancora inviato al remoto">da inviare</span>}
    </span>
    <span className="git-history-date" role="cell">{dateLabel(commit.date)}</span>
    <span className="git-history-author" role="cell">{commit.author}</span>
    <span className="git-history-hash" role="cell">{commit.shortHash}</span>
  </div>;
}

function GraphCell({ row, width }: { row: GraphRow; width: number }) {
  const x = (lane: number) => 12 + lane * LANE_WIDTH;
  return <svg width={width} height={ROW_HEIGHT} viewBox={`0 0 ${width} ${ROW_HEIGHT}`} aria-hidden="true">
    {row.start.map((hash, lane) => {
      if (hash === null) return null;
      if (hash === row.commit.hash) {
        return lane === row.column
          ? <line key={`start-${lane}`} x1={x(lane)} y1={0} x2={x(lane)} y2={ROW_HEIGHT / 2} stroke={laneStroke(lane)} strokeWidth={1.7} strokeLinecap="round" />
          : <path key={`start-${lane}`} d={`M ${x(lane)} 0 L ${x(row.column)} ${ROW_HEIGHT / 2}`} stroke={laneStroke(lane)} strokeWidth={1.7} strokeLinecap="round" fill="none" />;
      }
      if (row.end[lane] === hash) return <line key={`lane-${lane}`} x1={x(lane)} y1={0} x2={x(lane)} y2={ROW_HEIGHT} stroke={laneStroke(lane)} strokeWidth={1.7} />;
      return null;
    })}
    {row.edges.map((edge, index) => edge.to === edge.from
      ? <line key={`edge-${index}`} x1={x(edge.from)} y1={ROW_HEIGHT / 2} x2={x(edge.to)} y2={ROW_HEIGHT} stroke={laneStroke(edge.to)} strokeWidth={1.7} strokeLinecap="round" />
      : <path key={`edge-${index}`} d={`M ${x(edge.from)} ${ROW_HEIGHT / 2} C ${x(edge.from)} ${ROW_HEIGHT * 0.76}, ${x(edge.to)} ${ROW_HEIGHT * 0.74}, ${x(edge.to)} ${ROW_HEIGHT}`} stroke={laneStroke(edge.to)} strokeWidth={1.7} fill="none" strokeLinecap="round" />)}
    <circle cx={x(row.column)} cy={ROW_HEIGHT / 2} r={4} fill="var(--color-canvas)" stroke={laneStroke(row.column)} strokeWidth={2} />
  </svg>;
}
