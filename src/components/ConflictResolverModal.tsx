import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/tauri";
import { parseConflicts, resolveConflicts, type ConflictChoice, type ParsedConflicts } from "../lib/conflicts";
import { confirmAction } from "../lib/confirm";
import { AlertIcon, CheckIcon, XIcon } from "./Icons";

type ConflictFile = {
  path: string;
  parsed: ParsedConflicts | null;
  choices: Record<number, ConflictChoice>;
  saved: boolean;
};

type Props = {
  workspace: string;
  conflicts: string[];
  operation: "merge" | "cherry-pick";
  onClose: () => void;
  onResolved: (outcome: "completed" | "aborted") => void;
};

const choicesFor = (parsed: ParsedConflicts, choice: ConflictChoice) =>
  Object.fromEntries(parsed.segments.filter((segment) => segment.kind === "conflict").map((segment) => [segment.id, choice])) as Record<number, ConflictChoice>;

export function ConflictResolverModal({ workspace, conflicts, operation, onClose, onResolved }: Props) {
  const operationLabel = operation === "cherry-pick" ? "cherry-pick" : "merge";
  const [files, setFiles] = useState<ConflictFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const key = conflicts.join("\0");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all(conflicts.map(async (path): Promise<ConflictFile> => {
      try {
        const text = await api.readFile(path);
        return { path, parsed: parseConflicts(text), choices: {}, saved: false };
      } catch {
        return { path, parsed: null, choices: {}, saved: false };
      }
    })).then((value) => {
      if (cancelled) return;
      setFiles(value);
      setSelected(value[0]?.path ?? null);
      setError(null);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [workspace, key]);

  const remainingFor = (file: ConflictFile) => file.parsed ? resolveConflicts(file.parsed, file.choices).remaining : 0;
  const totalRemaining = useMemo(() => files.reduce((total, file) => total + remainingFor(file), 0), [files]);
  const unresolvedFiles = files.filter((file) => file.parsed ? remainingFor(file) > 0 : !file.saved);
  const file = files.find((item) => item.path === selected) ?? files[0] ?? null;

  const update = (path: string, patch: (file: ConflictFile) => ConflictFile) => {
    setFiles((current) => current.map((item) => item.path === path ? patch(item) : item));
  };

  const choose = (file: ConflictFile, id: number, choice: ConflictChoice) => {
    update(file.path, (item) => ({ ...item, saved: false, choices: { ...item.choices, [id]: choice } }));
  };

  const chooseFile = (file: ConflictFile, choice: ConflictChoice) => {
    if (!file.parsed) return;
    update(file.path, (item) => ({ ...item, saved: false, choices: choicesFor(file.parsed!, choice) }));
  };

  const chooseAll = (choice: ConflictChoice) => {
    setFiles((current) => current.map((item) => item.parsed ? { ...item, saved: false, choices: choicesFor(item.parsed, choice) } : item));
  };

  const takeSide = async (file: ConflictFile, side: "ours" | "theirs") => {
    setBusy(true);
    setError(null);
    try {
      await api.gitTakeSide(workspace, file.path, side);
      update(file.path, (item) => ({ ...item, saved: true }));
          } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveResolved = async (): Promise<ConflictFile[]> => {
    let current = files;
    for (const item of files) {
      if (!item.parsed || remainingFor(item) > 0 || item.saved) continue;
      const text = resolveConflicts(item.parsed, item.choices).text;
      await api.gitResolveConflict(workspace, item.path, text);
      current = current.map((entry) => entry.path === item.path ? { ...entry, saved: true } : entry);
    }
    setFiles(current);
        return current;
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const current = await saveResolved();
      const pending = current.filter((item) => item.parsed ? remainingFor(item) > 0 : !item.saved);
      if (pending.length) setError(`Restano ${pending.length} file da risolvere.`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    setBusy(true);
    setError(null);
    try {
      const current = await saveResolved();
      const pending = current.filter((item) => item.parsed ? remainingFor(item) > 0 : !item.saved);
      if (pending.length) {
        setError(`Risolvi ancora ${pending.length} file prima di completare il ${operationLabel}.`);
        return;
      }
      await api.gitCompleteMerge(workspace);
      onResolved("completed");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const abort = async () => {
    if (!(await confirmAction({
      title: `Annulla ${operationLabel}`,
      message: `Annullare il ${operationLabel} e ripristinare lo stato precedente?`,
      confirmLabel: `Annulla ${operationLabel}`,
      danger: true,
    }))) return;
    setBusy(true);
    setError(null);
    try {
      await api.gitAbortMerge(workspace);
      onResolved("aborted");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal-card conflict-modal" onClick={(event) => event.stopPropagation()}>
        <div className="conflict-header">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text)]"><AlertIcon className="h-5 w-5 text-[var(--warning)]" /> Risolvi conflitti</h2>
            <p className="mt-1 text-[13px] text-[var(--secondary)]">{unresolvedFiles.length} file ancora da risolvere · {totalRemaining} blocchi irrisolti</p>
          </div>
          <button type="button" className="icon-button" title="Chiudi" aria-label="Chiudi" onClick={onClose} disabled={busy}>
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        {loading ? <p className="p-5 text-[13px] text-[var(--muted)]">Lettura conflitti…</p> : (
          <>
            <div className="conflict-toolbar">
              <button type="button" className="ghost-button" disabled={busy} onClick={() => chooseAll("ours")}>Accetta tutte correnti</button>
              <button type="button" className="ghost-button" disabled={busy} onClick={() => chooseAll("theirs")}>Accetta tutte in arrivo</button>
              <span className="ml-auto text-xs text-[var(--muted)]">{files.length} file</span>
            </div>
            <div className="conflict-body">
              <aside className="conflict-files" aria-label="File in conflitto">
                {files.map((item) => {
                  const remaining = remainingFor(item);
                  return (
                    <button type="button" key={item.path} className={`conflict-file ${item.path === file?.path ? "is-active" : ""}`} onClick={() => setSelected(item.path)} title={item.path}>
                      <span className="min-w-0 flex-1 truncate">{item.path}</span>
                      {item.saved
                        ? <CheckIcon className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                        : <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--overlay)_10%,transparent)] px-1.5 text-[10px] text-[var(--muted)]">{item.parsed ? remaining : "!"}</span>}
                    </button>
                  );
                })}
              </aside>
              <div className="conflict-content scroll-area">
                {!file ? <div className="panel-empty">Nessun conflitto da mostrare.</div>
                  : !file.parsed || file.parsed.count === 0 ? (
                    <div className="panel-empty">
                      <AlertIcon className="h-5 w-5 text-[var(--warning)]" />
                      <span>Risoluzione manuale richiesta</span>
                      <p>Il file non contiene marcatori di conflitto (aggiunta/eliminazione o contenuto binario). Scegli quale versione mantenere.</p>
                      <div className="flex flex-wrap justify-center gap-2">
                        <button type="button" className="ghost-button rounded-md px-3 py-1.5 text-[13px]" disabled={busy} onClick={() => void takeSide(file, "ours")}>Prendi corrente</button>
                        <button type="button" className="ghost-button rounded-md px-3 py-1.5 text-[13px]" disabled={busy} onClick={() => void takeSide(file, "theirs")}>Prendi in arrivo</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="conflict-file-actions">
                        <span className="truncate font-mono text-xs text-[var(--muted)]">{file.path}</span>
                        <button type="button" className="ghost-button" disabled={busy} onClick={() => chooseFile(file, "ours")}>Tutte correnti</button>
                        <button type="button" className="ghost-button" disabled={busy} onClick={() => chooseFile(file, "theirs")}>Tutte in arrivo</button>
                      </div>
                      {file.parsed.segments.map((segment, index) => segment.kind === "context" ? (
                        <pre key={`c${index}`} className="conflict-context">{segment.lines.join("\n")}</pre>
                      ) : (
                        <div key={`x${segment.id}`} className={`conflict-block ${file.choices[segment.id] ? "is-resolved" : ""}`}>
                          <div className="conflict-block-head">
                            <span>Conflitto {segment.id + 1}</span>
                            <span className="text-[var(--muted)]">{file.choices[segment.id] === "ours" ? "Corrente" : file.choices[segment.id] === "theirs" ? "In arrivo" : file.choices[segment.id] === "both" ? "Entrambi" : "Da risolvere"}</span>
                          </div>
                          <div className="conflict-columns">
                            <section className="conflict-side is-current">
                              <header><span>Corrente (HEAD)</span><button type="button" disabled={busy} onClick={() => choose(file, segment.id, "ours")}>Accetta corrente</button></header>
                              <pre>{segment.ours.join("\n") || " "}</pre>
                            </section>
                            <section className="conflict-side is-incoming">
                              <header><span>In arrivo</span><button type="button" disabled={busy} onClick={() => choose(file, segment.id, "theirs")}>Accetta in arrivo</button></header>
                              <pre>{segment.theirs.join("\n") || " "}</pre>
                            </section>
                          </div>
                          <div className="conflict-block-foot">
                            <button type="button" disabled={busy} onClick={() => choose(file, segment.id, "both")}>Entrambi</button>
                            <button type="button" disabled={busy} onClick={() => update(file.path, (item) => { const next = { ...item.choices }; delete next[segment.id]; return { ...item, saved: false, choices: next }; })}>Ripristina</button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
              </div>
            </div>
          </>
        )}

        {error && <p className="modal-error">{error}</p>}

        <div className="conflict-footer">
          <button type="button" className="text-[13px] text-[var(--danger)] hover:text-[var(--danger)]" onClick={() => void abort()} disabled={busy}>Annulla {operationLabel}</button>
          <button type="button" className="ghost-button rounded-md px-3 py-1.5 text-[13px] ml-auto" onClick={onClose} disabled={busy}>Chiudi</button>
          <button type="button" className="ghost-button rounded-md px-3 py-1.5 text-[13px]" onClick={() => void save()} disabled={busy || loading}>Salva risolti</button>
          <button type="button" className="accent-button rounded-md px-3.5 py-1.5 text-[13px] font-semibold disabled:opacity-50" onClick={() => void complete()} disabled={busy || loading || unresolvedFiles.length > 0}>Completa {operationLabel}</button>
        </div>
      </div>
    </div>
  );
}
