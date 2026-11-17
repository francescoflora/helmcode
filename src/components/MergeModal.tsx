import { useEffect, useState } from "react";
import { api } from "../lib/tauri";
import type { GitBranch, MergeOutcome } from "../types";
import { ChevronRightIcon, GitBranchIcon, MergeIcon, XIcon } from "./Icons";

type Props = {
  workspace: string;
  currentBranch: string;
  mode: "choose" | "from";
  onBeforeMerge?: () => boolean | Promise<boolean>;
  onMerged: (outcome: MergeOutcome) => void;
  onClose: () => void;
};

export function MergeModal({ workspace, currentBranch, mode, onBeforeMerge, onMerged, onClose }: Props) {
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.gitBranches(workspace).then((value) => {
      if (cancelled) return;
      setBranches(value);
      const local = value.filter((branch) => !branch.remote);
      const destination = mode === "from"
        ? currentBranch
        : local.some((branch) => branch.name === currentBranch) ? currentBranch : local[0]?.name ?? currentBranch;
      setTarget(destination);
      setSource(value.find((branch) => branch.name !== destination)?.name ?? "");
      setError(null);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(String(reason));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [workspace, currentBranch, mode]);

  const destinations = branches.filter((branch) => !branch.remote);
  const sources = branches.filter((branch) => branch.name !== target);
  const valid = Boolean(source && target && source !== target && destinations.some((branch) => branch.name === target)) && !busy;

  const submit = async () => {
    if (!valid) return;
    if (onBeforeMerge && !(await onBeforeMerge())) return;
    setBusy(true);
    setError(null);
    try {
      onMerged(await api.gitMerge(workspace, source, target));
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
            <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--text)]"><MergeIcon className="h-5 w-5 text-[var(--accent)]" /> Esegui merge</h2>
            <p className="mt-1 text-[13px] text-[var(--secondary)]">
              {mode === "from" ? "Scegli il ramo da mergiare nel branch corrente." : "Scegli il ramo di partenza e quello di destinazione."}
            </p>
          </div>
          <button type="button" className="icon-button" title="Chiudi" aria-label="Chiudi" onClick={onClose} disabled={busy}>
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        {loading ? <p className="text-[13px] text-[var(--muted)]">Lettura branch…</p> : (
          <div className="merge-direction">
            <label className="merge-field">
              <span className="field-label">Da</span>
              <select aria-label="Ramo da mergiare" value={source} onChange={(event) => setSource(event.target.value)} disabled={busy}>
                {sources.map((branch) => <option key={`${branch.remote ? "r" : "l"}:${branch.name}`} value={branch.name}>{branch.name}{branch.remote ? " · remoto" : ""}</option>)}
              </select>
            </label>
            <ChevronRightIcon className="merge-arrow h-4 w-4 shrink-0" />
            <label className="merge-field">
              <span className="field-label">In</span>
              {mode === "from" ? (
                <div className="merge-target" title={target}><GitBranchIcon className="h-4 w-4 shrink-0" />{target || "HEAD"}</div>
              ) : (
                <select aria-label="Ramo di destinazione" value={target} onChange={(event) => { setTarget(event.target.value); if (event.target.value === source) setSource(branches.find((branch) => branch.name !== event.target.value)?.name ?? ""); }} disabled={busy}>
                  {destinations.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
                </select>
              )}
            </label>
          </div>
        )}

        {mode === "from" && target === "HEAD" && <p className="mt-3 text-xs text-[var(--warning)]">Sei su HEAD scollegato: seleziona un branch locale prima di mergiare.</p>}
        {error && <p className="modal-error">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="ghost-button rounded-md px-3.5 py-2 text-[13px]" onClick={onClose} disabled={busy}>Annulla</button>
          <button type="button" className="accent-button rounded-md px-3.5 py-2 text-[13px] font-semibold disabled:opacity-50" disabled={!valid || loading} onClick={() => void submit()}>
            {busy ? "Merge…" : "Esegui merge"}
          </button>
        </div>
      </div>
    </div>
  );
}
