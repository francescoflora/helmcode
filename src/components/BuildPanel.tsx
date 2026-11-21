import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { api } from "../lib/tauri";
import { buildApi, mergeTaskEvents, onTaskEvent, parseBuildDiagnostics, stripBuildAnsi, type BuildDiagnostic, type TaskEvent } from "../lib/build";
import { defaultsFor, resolveDefaultTask, withDefault, type BuildDefaultStore, type TaskKind } from "../lib/buildDefaults";
import { readStored, writeStored } from "../lib/storage";
import type { LspDiagnostic, WorkspaceTask, WorkspaceTasks } from "../types";
import { AlertIcon, BuildIcon, CheckIcon, ChevronRightIcon, PlayIcon, XIcon } from "./Icons";

type Run = {
  id: string;
  task: WorkspaceTask;
  output: string;
  state: "running" | "success" | "failed" | "cancelled";
  code?: number | null;
};

type Props = {
  workspace: string;
  version: number;
  diagnostics: Record<string, LspDiagnostic[]>;
  onOpenAt: (path: string, line: number, column: number) => void;
  onDiagnosticsChange?: (diagnostics: BuildDiagnostic[]) => void;
  onBeforeRun?: () => Promise<boolean>;
  problemsRequest?: number;
};

export function BuildPanel({ workspace, version, diagnostics, onOpenAt, onDiagnosticsChange, onBeforeRun, problemsRequest = 0 }: Props) {
  const [tasks, setTasks] = useState<WorkspaceTasks | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"problems" | "output">("problems");
  const [starting, setStarting] = useState(false);
  const [defaultStore, setDefaultStore] = useState<BuildDefaultStore>(() => readStored<BuildDefaultStore>("helmcode.build.defaults", {}));
  const [resultsOpen, setResultsOpen] = useState(() => readStored<boolean>("helmcode.build.resultsOpen", true));
  const [resultsHeight, setResultsHeight] = useState(() => {
    const stored = readStored<number>("helmcode.build.resultsHeight", 260);
    return Math.min(600, Math.max(100, stored));
  });
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const resultsHeightRef = useRef(resultsHeight);
  const resultsDrag = useRef<{ height: number; y: number; max: number } | null>(null);
  resultsHeightRef.current = resultsHeight;
  useEffect(() => {
    if (problemsRequest > 0) {
      setView("problems");
      setResultsOpen(true);
    }
  }, [problemsRequest]);
  const queuedEvents = useRef<TaskEvent[]>([]);
  const flushTimer = useRef<number | null>(null);
  const runIds = useRef(new Set<string>());
  const callbackRef = useRef(onDiagnosticsChange);
  callbackRef.current = onDiagnosticsChange;
  const outputRef = useRef<HTMLPreElement | null>(null);
  const selected = runs.find((run) => run.id === selectedId) ?? null;
  const running = runs.some((run) => run.state === "running");
  const latest = runs[runs.length - 1];
  const compileDiagnostics = useMemo(() => latest ? parseBuildDiagnostics(latest.output, workspace, latest.task) : [], [latest?.output, latest?.task, workspace]);
  const historyDiagnostics = useMemo(() => selected === latest ? null : selected ? parseBuildDiagnostics(selected.output, workspace, selected.task) : [], [selected?.output, selected?.task, workspace, selected === latest]);
  const selectedDiagnostics = historyDiagnostics ?? compileDiagnostics;
  const selectedOutput = useMemo(() => stripBuildAnsi(selected?.output ?? ""), [selected?.output]);
  const allProblems = useMemo(() => {
    const live: BuildDiagnostic[] = Object.entries(diagnostics).flatMap(([path, items]) => items.filter((item) => (item.severity ?? 1) <= 2).map((item) => ({
      path, line: item.range.start.line + 1, column: item.range.start.character + 1,
      severity: item.severity === 2 ? "warning" as const : "error" as const, message: item.message,
    })));
    const seen = new Set<string>();
    return [...live, ...selectedDiagnostics].filter((item) => {
      const key = `${item.path}:${item.line}:${item.column}:${item.severity}:${item.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [diagnostics, selectedDiagnostics]);

  useEffect(() => { callbackRef.current?.(compileDiagnostics); }, [compileDiagnostics]);

  useEffect(() => {
    if (!workspace) return;
    let disposed = false;
    setLoading(true);
    void api.workspaceTasks().then((value) => {
      if (!disposed) { setTasks(value); setError(null); }
    }).catch((reason: unknown) => {
      if (!disposed) setError(String(reason));
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [workspace, version]);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void onTaskEvent((event) => {
      if (disposed || !runIds.current.has(event.id)) return;
      queuedEvents.current.push(event);
      if (event.kind === "finished") runIds.current.delete(event.id);
      if (flushTimer.current !== null) return;
      flushTimer.current = window.setTimeout(() => {
        flushTimer.current = null;
        const events = queuedEvents.current.splice(0);
        setRuns((current) => mergeTaskEvents(current, events));
      }, 100);
    }).then((unlisten) => {
      if (disposed) unlisten(); else { cleanup = unlisten; setReady(true); }
    }).catch((reason: unknown) => { if (!disposed) setError(String(reason)); });
    return () => {
      disposed = true;
      cleanup?.();
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
      queuedEvents.current = [];
    };
  }, []);

  useEffect(() => {
    setRuns([]);
    setSelectedId(null);
    runIds.current.forEach((id) => void buildApi.stop(id).catch(() => undefined));
    runIds.current.clear();
    queuedEvents.current = [];
    callbackRef.current?.([]);
  }, [workspace]);

  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [selected?.output, view]);

  const runTask = useCallback(async (task: WorkspaceTask) => {
    if (!ready || starting || running) return;
    setStarting(true);
    setError(null);
    try {
      if (onBeforeRun && !await onBeforeRun()) return;
      const id = crypto.randomUUID();
      runIds.current.add(id);
      setRuns((current) => [...current.slice(-7), { id, task, output: "", state: "running" }]);
      setSelectedId(id);
      setView("output");
      try { await buildApi.run(task.id, id); }
      catch (reason) {
        setRuns((current) => current.map((run) => run.id === id ? { ...run, state: "failed", output: String(reason) } : run));
      }
    } catch (reason) { setError(String(reason)); }
    finally { setStarting(false); }
  }, [ready, running, starting, onBeforeRun]);

  const stopTask = async (id: string) => {
    try { await buildApi.stop(id); } catch (reason) { setError(String(reason)); }
  };
  const disabled = !ready || running || starting;

  const allTasks = tasks?.tasks ?? [];
  const defaults = defaultsFor(defaultStore, workspace);
  const defaultBuild = resolveDefaultTask(allTasks, "build", defaults.build, tasks?.build ?? null);
  const defaultPlay = resolveDefaultTask(allTasks, "play", defaults.play, tasks?.play ?? null);

  const chooseDefault = useCallback((kind: TaskKind, taskId: string) => {
    setDefaultStore((current) => {
      const next = withDefault(current, workspace, kind, taskId);
      writeStored("helmcode.build.defaults", next);
      return next;
    });
  }, [workspace]);

  const selectTask = (task: WorkspaceTask) => {
    if (task.kind === "build" || task.kind === "play") chooseDefault(task.kind, task.id);
  };

  const toggleResults = () => {
    const next = !resultsOpen;
    setResultsOpen(next);
    writeStored("helmcode.build.resultsOpen", next);
  };

  const beginResultsResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const results = resultsRef.current;
    const main = results?.parentElement;
    if (event.button !== 0 || !results || !main) return;
    resultsDrag.current = { height: results.getBoundingClientRect().height, y: event.clientY, max: main.clientHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveResultsResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resultsDrag.current;
    if (!drag) return;
    const max = Math.max(100, drag.max - 90);
    setResultsHeight(Math.min(max, Math.max(100, drag.height + drag.y - event.clientY)));
  };

  const endResultsResize = () => {
    if (!resultsDrag.current) return;
    resultsDrag.current = null;
    writeStored("helmcode.build.resultsHeight", resultsHeightRef.current);
  };

  return (
    <div className="build-panel">
      <div className="build-actions">
        <button type="button" disabled={disabled || !defaultBuild} onClick={() => defaultBuild && void runTask(defaultBuild)} className="build-primary" title={defaultBuild?.command ?? "Nessuna build rilevata"}><BuildIcon className="h-4.5 w-4.5" />Build</button>
        <button type="button" disabled={disabled || !defaultPlay} onClick={() => defaultPlay && void runTask(defaultPlay)} className="build-secondary" title={defaultPlay?.command ?? "Nessun comando di avvio"}><PlayIcon className="h-4.5 w-4.5" />Avvia</button>
        {running && <button type="button" className="build-stop" title="Interrompi processo" onClick={() => { const active = runs.find((run) => run.state === "running"); if (active) void stopTask(active.id); }}><span className="h-2 w-2 bg-current" />Stop</button>}
      </div>
      {error && <div role="alert" className="panel-error">{error}</div>}
      <div className="build-main">
        <div className="build-tasks-wrap">
          <div className="build-task-list">
            <div className="build-task-title">Task del progetto <span>{tasks?.tasks.length ?? 0}</span></div>
            {loading && !tasks && <p className="px-3 py-2 text-[13px] text-[var(--muted)]">Analisi progetto…</p>}
            {!loading && tasks?.tasks.length === 0 && <p className="px-3 py-2 text-[13px] leading-5 text-[var(--muted)]">Nessun task rilevato. Apri un progetto con package.json, Cargo.toml o pom.xml.</p>}
            <div className="scroll-area build-task-scroll">
              {tasks?.tasks.map((task) => {
                const defaultKind = task.id === defaultBuild?.id ? "build" : task.id === defaultPlay?.id ? "play" : null;
                const selectable = task.kind === "build" || task.kind === "play";
                const TaskIcon = task.kind === "play" ? PlayIcon : BuildIcon;
                const action = task.kind === "build" ? "usa come build predefinita" : task.kind === "play" ? "usa come avvio predefinito" : null;
                return (
                  <button type="button" key={task.id} title={action ? `${task.command} · ${action}` : task.command} onClick={() => selectTask(task)} className={`task-row ${defaultKind ? "is-default" : ""} ${selectable ? "" : "is-static"}`}>
                    <TaskIcon className="h-4.5 w-4.5 shrink-0" />
                    <span className="min-w-0 flex-1"><span className="block truncate text-[var(--secondary)]">{task.label}</span><span className="block truncate font-mono text-xs text-[var(--muted)]">{task.command}</span></span>
                    {defaultKind && <span className="shrink-0 text-[var(--accent)]" role="img" aria-label={defaultKind === "build" ? "Build predefinita" : "Avvio predefinito"} title={defaultKind === "build" ? "Build predefinita" : "Avvio predefinito"}><CheckIcon className="h-3.5 w-3.5" /></span>}
                    <span className="text-[11px] text-[var(--muted)]">{task.group}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div ref={resultsRef} className={`build-results ${resultsOpen ? "" : "is-collapsed"}`} style={resultsOpen ? { height: resultsHeight } : undefined}>
          {resultsOpen && <div className="build-results-resizer" role="separator" aria-label="Ridimensiona la sezione Problemi e Output" aria-orientation="horizontal" tabIndex={0} title="Trascina per ridimensionare la sezione" onPointerDown={beginResultsResize} onPointerMove={moveResultsResize} onPointerUp={endResultsResize} onPointerCancel={endResultsResize} onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const next = Math.min(600, Math.max(100, resultsHeightRef.current + (event.key === "ArrowUp" ? 24 : -24)));
            setResultsHeight(next);
            writeStored("helmcode.build.resultsHeight", next);
          }} />}
          <div className="build-view-tabs" role="tablist" aria-label="Risultati di build">
            <button type="button" role="tab" aria-selected={view === "problems"} className={view === "problems" ? "is-active" : ""} onClick={() => setView("problems")}>Problemi <span>{allProblems.length}</span></button>
            <button type="button" role="tab" aria-selected={view === "output"} className={view === "output" ? "is-active" : ""} onClick={() => setView("output")}>Output {running && <span className="running-dot" />}</button>
            <button type="button" className="build-results-toggle" aria-expanded={resultsOpen} aria-label={resultsOpen ? "Comprimi la sezione Problemi e Output" : "Espandi la sezione Problemi e Output"} title={resultsOpen ? "Comprimi la sezione" : "Espandi la sezione"} onClick={toggleResults}>
              <ChevronRightIcon className={`h-3.5 w-3.5 transition-transform ${resultsOpen ? "rotate-90" : "-rotate-90"}`} />
            </button>
          </div>
          {resultsOpen && <>
            {runs.length > 0 && <div className="build-history"><select aria-label="Cronologia build" value={selectedId ?? ""} onChange={(event) => setSelectedId(event.target.value)}>{[...runs].reverse().map((run) => <option key={run.id} value={run.id}>{run.task.label} · {runLabel(run)}</option>)}</select></div>}
            {view === "problems" ? (
              <div className="scroll-area min-h-0 flex-1 overflow-auto">
                {allProblems.length === 0 && <div className="panel-empty"><CheckIcon className="h-5 w-5 text-[var(--accent)]/60" /><span>Nessun problema rilevato</span><p>I problemi dell'editor e delle build appariranno qui.</p></div>}
                {allProblems.map((problem, index) => <button type="button" key={`${problem.path}:${problem.line}:${index}`} className="problem-row" disabled={!problem.path} onClick={() => onOpenAt(problem.path, problem.line, problem.column)} title={problem.path ? `${problem.path}:${problem.line}:${problem.column}` : "Problema del progetto"}><AlertIcon className={`mt-0.5 h-4.5 w-4.5 shrink-0 ${problem.severity === "error" ? "text-[var(--danger)]" : "text-[var(--warning)]"}`} /><span className="min-w-0 flex-1"><span className="block break-words text-[13px] leading-5 text-[var(--secondary)]">{problem.message}</span><span className="block truncate text-xs text-[var(--muted)]">{problem.path || "Progetto"} {problem.path && <span className="text-[var(--muted)]">:{problem.line}:{problem.column}</span>}</span></span></button>)}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col">
                {selected ? <><div className="build-result"><span className={selected.state === "failed" ? "text-[var(--danger)]" : selected.state === "success" ? "text-[var(--accent)]" : "text-[var(--secondary)]"}>{runLabel(selected)}</span><span className="truncate text-[var(--muted)]">{selected.task.command}</span></div><pre ref={outputRef} className="scroll-area build-output">{selectedOutput || (selected.state === "running" ? "Avvio…" : "Nessun output.")}</pre></> : <div className="panel-empty"><BuildIcon className="h-5 w-5 text-[var(--muted)]" /><span>Pronto per la prossima build</span><p>Scegli Build o Avvia; imposta i task predefiniti dalla lista del progetto.</p></div>}
              </div>
            )}
          </>}
        </div>
      </div>
      <div className="build-footnote"><span className="h-1 w-1 rounded-full bg-[var(--accent)]/60" />{running ? "Processo in esecuzione" : "Output e problemi del progetto"}{selected && selected.state !== "running" && <button type="button" title="Rimuovi risultato" aria-label="Rimuovi risultato" className="icon-button ml-auto shrink-0" onClick={() => { setRuns((current) => current.filter((run) => run.id !== selected.id)); setSelectedId(runs.filter((run) => run.id !== selected.id).at(-1)?.id ?? null); }}><XIcon className="h-4.5 w-4.5" /></button>}</div>
    </div>
  );
}

function runLabel(run: Run) {
  return run.state === "running" ? "In esecuzione" : run.state === "success" ? "Completato" : run.state === "cancelled" ? "Interrotto" : `Fallito${run.code == null ? "" : ` · ${run.code}`}`;
}
