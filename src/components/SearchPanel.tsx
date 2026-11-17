import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api } from "../lib/tauri";
import type { FileMatch, ReplaceRequest, ReplaceResult, SearchDocument, SearchMatch, SearchOptions, Tab } from "../types";
import { ChevronRightIcon, XIcon } from "./Icons";
import { FileTypeIcon } from "./FileTypeIcon";

type Props = {
  workspace: string;
  active: boolean;
  tabs: Tab[];
  version: number;
  focusRequest: { nonce: number; replace: boolean };
  disabled: boolean;
  onOpenAt: (path: string, line: number, column: number) => void;
  onReplace: (request: ReplaceRequest) => Promise<ReplaceResult>;
};

export function SearchPanel({ workspace, active, tabs, version, focusRequest, disabled, onOpenAt, onReplace }: Props) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [options, setOptions] = useState<SearchOptions>({ caseSensitive: false, wholeWord: false, useRegex: false, preserveCase: false });
  const [refresh, setRefresh] = useState(0);
  const [replacing, setReplacing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const queryRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [files, setFiles] = useState<FileMatch[]>([]);
  const [filesOpen, setFilesOpen] = useState(true);
  const [contentsOpen, setContentsOpen] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const fileRequestRef = useRef(0);
  const operationRef = useRef(false);
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const documentsRef = useRef<SearchDocument[]>([]);
  const documents = useMemo(() => {
    // Clean tabs already match disk. Opening a tab or saving an older snapshot
    // must not resend every open file or invalidate an unchanged search overlay.
    const dirty = tabs.filter((tab) => !tab.external && tab.content !== tab.savedContent);
    const previous = documentsRef.current;
    if (dirty.length === previous.length && dirty.every((tab, index) => tab.path === previous[index].path && tab.content === previous[index].text)) return previous;
    return documentsRef.current = dirty.map((tab) => ({ path: tab.path, text: tab.content, savedText: tab.savedContent }));
  }, [tabs]);
  const previewReplacement = replaceOpen ? replacement : undefined;
  const searchContext = useMemo(() => ({}), [query, workspace, options, documents, version, refresh, previewReplacement]);
  const [completedSearch, setCompletedSearch] = useState<object | null>(null);

  useEffect(() => {
    if (!focusRequest.nonce) return;
    if (focusRequest.replace) setReplaceOpen(true);
    queryRef.current?.focus();
    queryRef.current?.select();
  }, [focusRequest]);

  useEffect(() => {
    requestRef.current += 1;
    fileRequestRef.current += 1;
    setQuery("");
    setReplacement("");
    setMessage(null);
    setCollapsedFiles(new Set());
    setResults([]);
    setFiles([]);
    setError(null);
    setFileError(null);
    setContentLoading(false);
    setFilesLoading(false);
  }, [workspace]);

  useEffect(() => {
    requestRef.current += 1;
    const request = requestRef.current;
    if (!active || disabled) {
      setContentLoading(false);
      return;
    }
    if (!query) {
      setResults([]);
      setError(null);
      setContentLoading(false);
      return;
    }

    setContentLoading(true);
    setError(null);
    setResults([]);
    const timer = window.setTimeout(() => {
      api.searchText(query, options.caseSensitive, options, documents, previewReplacement)
        .then((contentMatches) => {
          if (requestRef.current !== request) return;
          setResults(contentMatches);
          setError(null);
          setCompletedSearch(searchContext);
        })
        .catch((reason: unknown) => {
          if (requestRef.current !== request) return;
          setError(String(reason));
          setResults([]);
        })
        .finally(() => {
          if (requestRef.current === request) setContentLoading(false);
        });
    }, 250);

    return () => { window.clearTimeout(timer); if (requestRef.current === request) requestRef.current += 1; };
  }, [active, disabled, query, workspace, options, documents, version, refresh, previewReplacement, searchContext]);

  useEffect(() => {
    const request = ++fileRequestRef.current;
    if (!active || disabled) {
      setFilesLoading(false);
      return;
    }
    if (!query.trim()) {
      setFiles([]);
      setFileError(null);
      setFilesLoading(false);
      return;
    }
    setFilesLoading(true);
    setFileError(null);
    setFiles([]);
    const timer = window.setTimeout(() => {
      api.searchFiles(query).then((matches) => {
        if (fileRequestRef.current === request) setFiles(matches);
      }).catch((reason: unknown) => {
        if (fileRequestRef.current === request) setFileError(String(reason));
      }).finally(() => {
        if (fileRequestRef.current === request) setFilesLoading(false);
      });
    }, 250);
    return () => { window.clearTimeout(timer); if (fileRequestRef.current === request) fileRequestRef.current += 1; };
  }, [active, disabled, query, workspace, version, refresh]);

  const groups = useMemo(() => {
    const map = new Map<string, SearchMatch[]>();
    for (const match of results) {
      const list = map.get(match.path) ?? [];
      list.push(match);
      map.set(match.path, list);
    }
    return Array.from(map.entries());
  }, [results]);

  const searching = query.length > 0;
  const total = files.length + results.length;
  const loading = contentLoading || filesLoading;
  const busy = disabled || replacing;
  const canReplace = active && !busy && !contentLoading && !error && completedSearch === searchContext && results.length > 0;
  const visibleError = error ?? fileError;
  const toggleOption = (key: keyof SearchOptions) => { setOptions((current) => ({ ...current, [key]: !current[key] })); setMessage(null); };
  const runReplace = async (path?: string, match?: SearchMatch) => {
    if (!canReplace || operationRef.current) return;
    operationRef.current = true;
    const requestedWorkspace = workspace;
    requestRef.current += 1;
    setReplacing(true);
    setError(null);
    setMessage(null);
    try {
      const result = await onReplace({ query, replacement, ...options, path, match });
      if (workspaceRef.current !== requestedWorkspace) return;
      setMessage(`${result.count} ${result.count === 1 ? "occorrenza sostituita" : "occorrenze sostituite"} in ${result.documents.length} file.`);
    } catch (reason) {
      if (workspaceRef.current === requestedWorkspace) setMessage(`Sostituzione non completata: ${String(reason)}`);
    } finally {
      operationRef.current = false;
      setReplacing(false);
      if (workspaceRef.current === requestedWorkspace) setRefresh((value) => value + 1);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="search-controls">
        <button type="button" className="search-expand" title="Mostra/nascondi Sostituisci (Ctrl+Shift+R)" aria-label="Mostra sostituisci" aria-expanded={replaceOpen} onClick={() => setReplaceOpen((open) => !open)}>
          <ChevronRightIcon className={`h-4 w-4 ${replaceOpen ? "rotate-90" : ""}`} />
        </button>
        <div className="min-w-0 flex-1 space-y-1.5">
        <div className="search-field">
          <input
            ref={queryRef}
            aria-label="Cerca nel progetto"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setMessage(null); }}
            onKeyDown={(event) => { if (event.key === "Enter") setRefresh((value) => value + 1); if (event.key === "ArrowDown" && replaceOpen) { event.preventDefault(); replaceRef.current?.focus(); } }}
            placeholder="Cerca"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            translate="no"
            {...{ writingsuggestions: "false" }}
            className="search-input min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
          />
          <SearchOption label="Distingui maiuscole/minuscole" active={options.caseSensitive} onClick={() => toggleOption("caseSensitive")}>Aa</SearchOption>
          <SearchOption label="Parola intera" active={options.wholeWord} onClick={() => toggleOption("wholeWord")}><span className="underline underline-offset-2">ab</span></SearchOption>
          <SearchOption label="Usa espressione regolare" active={options.useRegex} onClick={() => toggleOption("useRegex")}>.*</SearchOption>
        </div>
        {replaceOpen && <div className="flex min-w-0 items-center gap-1">
          <div className="search-field min-w-0 flex-1">
            <input ref={replaceRef} aria-label="Sostituisci con" value={replacement} onChange={(event) => { setReplacement(event.target.value); setMessage(null); }} placeholder="Sostituisci" spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" className="search-input min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text)] outline-none placeholder:text-[var(--muted)]"
              onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void runReplace(); } if (event.key === "Escape") { setReplaceOpen(false); queryRef.current?.focus(); } }} />
            <SearchOption label="Mantieni maiuscole/minuscole" active={options.preserveCase} onClick={() => toggleOption("preserveCase")}>AB</SearchOption>
          </div>
          <button type="button" className="search-action" disabled={!canReplace} aria-label="Sostituisci tutto" title="Sostituisci tutto (Ctrl+Invio)" onClick={() => void runReplace()}><ReplaceIcon all /></button>
        </div>}
        </div>
        {query && <div className="col-start-2 flex items-center justify-end">
          <button type="button" className="search-action" title="Pulisci ricerca" aria-label="Pulisci ricerca" onClick={() => { setQuery(""); setMessage(null); }}><XIcon className="h-3.5 w-3.5" /></button>
        </div>}
      </div>

      {message && <div role="status" className="px-3 py-2 text-xs text-[var(--secondary)]">{message}</div>}

      {searching && <div className="flex shrink-0 items-center justify-between px-3 py-1.5 text-xs text-[var(--muted)]">
        <span>
          {replacing ? "Sostituzione…" : loading
            ? "Ricerca…"
            : `${total} risultati`}
        </span>
        {(files.length >= 200 || results.length >= 200) && <span title="Anteprima limitata a 200 risultati. Sostituisci tutto agisce su tutte le occorrenze del progetto." className="text-[var(--warning)]">anteprima limitata</span>}
      </div>}

      <div className="scroll-area min-h-0 flex-1 overflow-auto px-1.5 pb-2">
        {loading && total === 0 && (
          <div className="px-2 py-3 text-xs text-[var(--muted)]">Ricerca in corso…</div>
        )}
        {visibleError && (
          <div className="mx-1.5 rounded-lg border border-red-400/20 bg-red-400/10 px-2.5 py-2 text-xs text-[var(--danger)]">
            {visibleError}
          </div>
        )}
        {!loading && !visibleError && searching && total === 0 && (
          <div className="px-2 py-3 text-xs text-[var(--muted)]">Nessun risultato.</div>
        )}

        {files.length > 0 && (
          <SearchSection label="File" count={files.length} open={filesOpen} onToggle={() => setFilesOpen((value) => !value)}>
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => onOpenAt(file.path, 1, 1)}
                title={file.path}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--overlay)_5%,transparent)]"
              >
                <FileTypeIcon path={file.path} className="h-4.5 w-4.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--secondary)]">{highlightMatch(file.path, query)}</span>
              </button>
            ))}
          </SearchSection>
        )}

        {results.length > 0 && (
          <SearchSection label="Contenuti" count={results.length} open={contentsOpen} onToggle={() => setContentsOpen((value) => !value)}>
            {groups.map(([path, matches]) => (
              <div key={path} className="mb-1.5">
                <div className="flex items-center gap-2 rounded-md px-2 py-2 text-[13px] text-[var(--secondary)]">
                  <button type="button" className="search-action" aria-label={`Mostra risultati ${path}`} aria-expanded={!collapsedFiles.has(path)} onClick={() => setCollapsedFiles((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; })}><ChevronRightIcon className={`h-3.5 w-3.5 ${collapsedFiles.has(path) ? "" : "rotate-90"}`} /></button>
                  <FileTypeIcon path={path} className="h-4.5 w-4.5 shrink-0" />
                  <span className="truncate" title={path}>
                    {path}
                  </span>
                  <span className="ml-auto rounded-full bg-[color-mix(in_srgb,var(--overlay)_6%,transparent)] px-1.5 text-xs text-[var(--muted)]">
                    {matches.length}
                  </span>
                  {replaceOpen && <button type="button" className="search-action" disabled={!canReplace} title={`Sostituisci tutto in ${path}`} aria-label={`Sostituisci nel file ${path}`} onClick={() => void runReplace(path)}><ReplaceIcon all /></button>}
                </div>
                {!collapsedFiles.has(path) && matches.map((match) => (
                  <div key={`${match.path}:${match.line}:${match.column}`} className="search-result-row">
                  <button
                    key={`${match.path}:${match.line}:${match.column}`}
                    type="button"
                    onClick={() => onOpenAt(match.path, match.line, match.column)}
                    title={`${match.path}:${match.line}:${match.column}`}
                    className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--overlay)_5%,transparent)]"
                  >
                    <span className="w-7 shrink-0 pt-px text-right font-mono text-xs text-[var(--muted)]">
                      {match.line}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs leading-relaxed text-[var(--secondary)]">
                      {match.prefix}
                      <span className={replaceOpen ? "search-match-removed" : "rounded bg-[var(--accent)]/25 px-0.5 text-[var(--accent)]"}>
                        {match.matched || "∅"}
                      </span>
                      {replaceOpen && <span className="search-match-added">{match.replacement ?? replacement}</span>}
                      {match.suffix}
                    </span>
                  </button>
                  {replaceOpen && <button type="button" className="search-action search-replace-one" disabled={!canReplace} title="Sostituisci questa occorrenza" aria-label={`Sostituisci ${path}:${match.line}:${match.column}`} onClick={() => void runReplace(path, match)}><ReplaceIcon /></button>}
                  </div>
                ))}
              </div>
            ))}
          </SearchSection>
        )}
      </div>
    </div>
  );
}

function SearchOption({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={`search-option ${active ? "is-active" : ""}`} title={label} aria-label={label} aria-pressed={active} onClick={onClick}>{children}</button>;
}

function ReplaceIcon({ all = false }: { all?: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="M3 2h7M3 5h5M2 8h7m-2-2 2 2-2 2M5 12h7M5 15h7" />{all && <path d="M12 2h2v7h-2" />}</svg>;
}

function SearchSection({ label, count, open, onToggle, children }: {
  label: string; count: number; open: boolean; onToggle: () => void; children: ReactNode;
}) {
  return (
    <div className="mb-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)] hover:bg-[color-mix(in_srgb,var(--overlay)_4%,transparent)] hover:text-[var(--secondary)]"
      >
        <ChevronRightIcon className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span>{label}</span>
        <span className="rounded-full bg-[color-mix(in_srgb,var(--overlay)_6%,transparent)] px-1.5 font-mono text-[10px] font-normal normal-case tracking-normal">{count}</span>
      </button>
      {open && <div className="mt-0.5">{children}</div>}
    </div>
  );
}

function highlightMatch(text: string, query: string) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (!query || index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <span className="rounded bg-[var(--accent)]/25 px-0.5 text-[var(--accent)]">{text.slice(index, index + query.length)}</span>
      {text.slice(index + query.length)}
    </>
  );
}
