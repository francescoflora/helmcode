import { useState } from "react";
import { api } from "../lib/tauri";
import type { GitBranch, GitStatus } from "../types";
import { CheckIcon, GitBranchIcon, PlusIcon, XIcon } from "./Icons";

type Props = {
  workspace: string;
  current: string;
  branches: GitBranch[];
  hasChanges: boolean;
  onSaveAll: () => Promise<boolean>;
  onCreated: (status: GitStatus, stashed: boolean) => void;
  onClose: () => void;
};

export function CreateBranchModal({ workspace, current, branches, hasChanges, onSaveAll, onCreated, onClose }: Props) {
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"current" | "base">("current");
  const [base, setBase] = useState(current);
  const [carry, setCarry] = useState<"keep" | "discard">("keep");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const local = branches.filter((branch) => !branch.remote);
  const remote = branches.filter((branch) => branch.remote);
  const trimmed = name.trim();
  const duplicate = local.some((branch) => branch.name === trimmed);
  const switchesBranch = mode === "base" && base !== current;
  const changeChoice = switchesBranch && hasChanges;
  const valid = Boolean(trimmed) && !duplicate && !busy;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await onSaveAll())) return;
      const status = await api.gitCreateBranch(workspace, trimmed, switchesBranch ? base : null, !changeChoice || carry === "keep");
      onCreated(status, changeChoice && carry === "discard");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal-card max-w-md" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text)]">
              <GitBranchIcon className="h-5 w-5 text-[var(--accent)]" /> Nuovo branch
            </h2>
            <p className="mt-1 text-[13px] text-[var(--secondary)]">
              {current ? `Branch corrente: ${current}.` : "Scegli il punto di partenza del nuovo branch."}
            </p>
          </div>
          <button type="button" className="icon-button" title="Chiudi" aria-label="Chiudi" onClick={onClose} disabled={busy}>
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        <label className="field-label" htmlFor="branch-name">Nome</label>
        <input id="branch-name" className="field-input" type="text" value={name} autoFocus disabled={busy} spellCheck={false}
          placeholder="feature/nuova-funzione" aria-label="Nome del nuovo branch"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} />
        {duplicate && <p className="mt-2 text-xs text-[var(--danger)]">Esiste già un branch locale con questo nome.</p>}

        <p className="field-label mt-4">Partenza</p>
        <div className="window-choice">
          <button type="button" className="window-choice-option" aria-pressed={mode === "current"} disabled={busy}
            onClick={() => setMode("current")}>
            {mode === "current" ? <CheckIcon className="h-5 w-5 shrink-0" /> : <PlusIcon className="h-5 w-5 shrink-0" />}
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-[var(--text)]">Da ciò che ho ora</span>
              <span className="block text-xs text-[var(--muted)]">Parte dal branch corrente e mantiene le modifiche non committate.</span>
            </span>
          </button>
          <button type="button" className="window-choice-option" aria-pressed={mode === "base"} disabled={busy}
            onClick={() => setMode("base")}>
            {mode === "base" ? <CheckIcon className="h-5 w-5 shrink-0" /> : <GitBranchIcon className="h-5 w-5 shrink-0" />}
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-[var(--text)]">Da un branch</span>
              <span className="block text-xs text-[var(--muted)]">Scegli il branch di partenza del nuovo branch.</span>
            </span>
          </button>
        </div>

        {mode === "base" && (
          <label className="merge-field mt-3">
            <span className="field-label">Branch di partenza</span>
            <select id="branch-base" value={base} disabled={busy} aria-label="Branch di partenza" onChange={(event) => setBase(event.target.value)}>
              {local.map((branch) => <option key={`l:${branch.name}`} value={branch.name}>{branch.name}{branch.name === current ? " · corrente" : ""}</option>)}
              {remote.map((branch) => <option key={`r:${branch.name}`} value={branch.name}>{branch.name} · remoto</option>)}
            </select>
          </label>
        )}

        {changeChoice && (
          <>
            <p className="field-label mt-4">Modifiche non committate</p>
            <div className="window-choice">
              <button type="button" className="window-choice-option" aria-pressed={carry === "keep"} disabled={busy}
                onClick={() => setCarry("keep")}>
                {carry === "keep" ? <CheckIcon className="h-5 w-5 shrink-0" /> : <GitBranchIcon className="h-5 w-5 shrink-0" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-[var(--text)]">Porta le modifiche</span>
                  <span className="block text-xs text-[var(--muted)]">Le modifiche entrano nel nuovo branch.</span>
                </span>
              </button>
              <button type="button" className="window-choice-option" aria-pressed={carry === "discard"} disabled={busy}
                onClick={() => setCarry("discard")}>
                {carry === "discard" ? <CheckIcon className="h-5 w-5 shrink-0" /> : <PlusIcon className="h-5 w-5 shrink-0" />}
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-[var(--text)]">Annulla le modifiche</span>
                  <span className="block text-xs text-[var(--muted)]">Il nuovo branch parte pulito. Le modifiche restano recuperabili nello stash.</span>
                </span>
              </button>
            </div>
          </>
        )}

        {error && <p className="modal-error">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="ghost-button rounded-md px-3.5 py-2 text-[13px]" onClick={onClose} disabled={busy}>Annulla</button>
          <button type="button" className="accent-button rounded-md px-3.5 py-2 text-[13px] font-semibold disabled:opacity-50" disabled={!valid} onClick={() => void submit()}>
            {busy ? "Creazione…" : "Crea branch"}
          </button>
        </div>
      </div>
    </div>
  );
}
