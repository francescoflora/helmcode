import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { layoutCommitGraph, laneColor, type GraphRow } from "../lib/gitGraph";
import { api } from "../lib/tauri";
import type { GitCommitFile, GitLog } from "../types";
import { CommitDiff } from "./CommitDiff";
import { FileTypeIcon } from "./FileTypeIcon";
import { GitBranchIcon, RefreshIcon } from "./Icons";

const PAGE_SIZE = 300;
const MAX_COMMITS = 2000;
const ROW_HEIGHT = 30;
const LANE_WIDTH = 18;
const laneStroke = (lane: number) => `var(--git-lane-${lane % 12}, ${laneColor(lane)})`;
type Props = { workspace: string; version: number };
type SelectedFile = { hash: string; shortHash: string; path: string; oldPath: string | null };

function dateLabel(value: string, full = false): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value :
    date.toLocaleString("it-IT", full ? { dateStyle: "full", timeStyle: "long" } : { dateStyle: "medium", timeStyle: "short" });
}

function refLabel(value: string): { label: string; kind: "head" | "tag" | "branch" } {
  if (value.startsWith("HEAD -> ")) return { label: value.slice(8), kind: "head" };
  if (value.startsWith("tag: ")) return { label: value.slice(5), kind: "tag" };
  return { label: value, kind: "branch" };
}

export function GitHistory({ workspace, version }: Props) {
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
  const filesRequest = useRef(0);

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

  const layout = useMemo(() => layoutCommitGraph(log?.commits ?? []), [log]);
  const graphWidth = Math.max(40, 24 + (layout.lanes - 1) * LANE_WIDTH);
  const commitCount = log?.commits.length ?? 0;

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
        <div className="git-history-table" role="table" style={{ "--graph-width": `${graphWidth}px` } as CSSProperties}>
          <div className="git-history-table-header" role="row">
            <span role="columnheader">Grafo</span>
            <span role="columnheader">Descrizione</span>
            <span role="columnheader">Data</span>
            <span role="columnheader">Autore</span>
            <span role="columnheader">Commit</span>
          </div>
          {layout.rows.map((row) => <Fragment key={row.commit.hash}>
            <CommitRow row={row} width={graphWidth} expanded={expanded === row.commit.hash} onSelect={() => toggleCommit(row)} />
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
  </section>;
}

function CommitRow({ row, width, expanded, onSelect }: { row: GraphRow; width: number; expanded: boolean; onSelect: () => void }) {
  const { commit } = row;
  return <div className={`git-history-row ${expanded ? "is-expanded" : ""}`} role="row" tabIndex={0} aria-expanded={expanded}
    onClick={onSelect}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }}
    title={`${commit.hash}\n${commit.author} <${commit.email}>\n${dateLabel(commit.date, true)}`}>
    <span className="git-history-graph" role="cell"><GraphCell row={row} width={width} /></span>
    <span className="git-history-description" role="cell">
      <span className="git-history-subject-text">{commit.subject}</span>
      {commit.refs.map((value) => {
        const ref = refLabel(value);
        return <span key={value} className={`git-ref is-${ref.kind}`}>{ref.label}</span>;
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
