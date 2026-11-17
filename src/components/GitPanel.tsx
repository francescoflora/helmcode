import { useEffect, useRef, useState } from "react";
import { api } from "../lib/tauri";
import type { GitStatus, MergeOutcome } from "../types";
import { AlertIcon, CheckIcon, ChevronRightIcon, CloudUpIcon, CrosshairIcon, DiscardIcon, GitBranchIcon, MergeIcon } from "./Icons";
import { FileTypeIcon } from "./FileTypeIcon";
import { MergeModal } from "./MergeModal";
import { ConflictResolverModal } from "./ConflictResolverModal";

type Props = {
  workspace: string;
  status: GitStatus | null;
  activePath?: string | null;
  onReveal: (path: string) => void;
  onDiff: (path: string) => void;
  onRevert: (path: string, untracked: boolean) => void;
  onRefresh: () => void;
  onBeforeMerge?: () => boolean | Promise<boolean>;
  onNotify?: (message: string) => void;
};
const statusLabels: Record<string, string> = {
  M: "Modificato", A: "Aggiunto", D: "Eliminato", R: "Rinominato",
  C: "Copiato", U: "Nuovo", "?": "Nuovo", "!": "Conflitto",
};

export function GitPanel({ workspace, status, activePath, onReveal, onDiff, onRevert, onRefresh, onBeforeMerge, onNotify }: Props) {
  const [mergeMode, setMergeMode] = useState<"choose" | "from" | null>(null);
  const [resolverConflicts, setResolverConflicts] = useState<string[] | null>(null);

  useEffect(() => {
    setMergeMode(null);
    setResolverConflicts(null);
  }, [workspace]);

  if (!status) return <div className="px-4 py-5 text-[13px] text-[var(--muted)]">Lettura stato Git…</div>;
  if (!status.isRepo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <GitBranchIcon className="h-6 w-6 text-[var(--muted)]" />
        <div className="text-[13px] text-[var(--secondary)]">Nessun repository Git</div>
        <p className="max-w-[240px] text-xs leading-relaxed text-[var(--muted)]">Apri un progetto con Git per consultare branch e differenze.</p>
      </div>
    );
  }

  const conflicts = status.changes.filter((change) => change.label === "!").map((change) => change.path);

  const handleMerged = (outcome: MergeOutcome) => {
    setMergeMode(null);
    onRefresh();
    if (outcome.conflicts.length) {
      setResolverConflicts(outcome.conflicts);
    } else {
      onNotify?.("Merge completato.");
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CommitBox workspace={workspace} status={status} onCommitted={onRefresh} onMerge={setMergeMode} />
      {conflicts.length > 0 && <button type="button" className="git-resolve-conflicts" onClick={() => setResolverConflicts(conflicts)}><AlertIcon className="h-4 w-4 shrink-0" />Risolvi conflitti ({conflicts.length})</button>}
      {status.merging && conflicts.length === 0 && <button type="button" className="git-resolve-conflicts" onClick={() => setResolverConflicts([])}><MergeIcon className="h-4 w-4 shrink-0" />Completa merge</button>}
      <div className="scroll-area min-h-0 flex-1 overflow-auto py-2">
        <div className="mb-4">
          <div className="mb-1 flex items-center justify-between px-3 text-xs font-medium text-[var(--muted)]"><span>Modifiche</span><span>{status.changes.length}</span></div>
          {status.changes.map((change) => {
            const revertLabel = change.untracked ? `Elimina ${change.path} (file non tracciato)`
              : change.label === "D" ? `Ripristina ${change.path}` : `Scarta le modifiche a ${change.path}`;
            return (
              <div key={change.path} className={`git-change group flex items-center gap-1 px-2 hover:bg-[color-mix(in_srgb,var(--overlay)_4%,transparent)] ${change.path === activePath ? "is-active" : ""}`}>
                <button type="button" onClick={() => onDiff(change.path)} title={`${change.path} · ${statusLabels[change.label] ?? change.label} · confronta con Git`} className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left">
                  <FileTypeIcon path={change.path} className="h-[18px] w-[18px] shrink-0" />
                  <span className={`w-4 shrink-0 text-center font-mono text-xs ${change.label === "D" ? "text-[var(--danger)]" : change.untracked || change.label === "A" ? "text-[var(--accent)]" : "text-[var(--warning)]"}`}>{change.label}</span>
                  <span className="truncate text-[13px] text-[var(--secondary)] group-hover:text-[var(--secondary)]">{change.path}</span>
                </button>
                <div className="git-change-actions shrink-0">
                  {change.label !== "D" && <button type="button" onClick={() => onReveal(change.path)} title="Rivela nell'esplora file" aria-label={`Rivela ${change.path} nell'esplora file`} className="icon-button"><CrosshairIcon className="h-4 w-4" /></button>}
                  <button type="button" onClick={() => onRevert(change.path, change.untracked)} title={revertLabel} aria-label={revertLabel} className="icon-button"><DiscardIcon className="h-4 w-4" /></button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="panel-footer git-panel-footer">
        <span>{status.changes.length} {status.changes.length === 1 ? "file modificato" : "file modificati"} · confronto con HEAD</span>
        <span className="git-panel-branch" title={status.upstream ? `Confronto con ${status.upstream}` : "Nessun branch remoto associato"}>
          {status.branch}{status.ahead > 0 && ` · ↑${status.ahead}`}{status.behind > 0 && ` · ↓${status.behind}`}
        </span>
      </div>
      {mergeMode && <MergeModal workspace={workspace} currentBranch={status.branch} mode={mergeMode} onBeforeMerge={onBeforeMerge} onMerged={handleMerged} onClose={() => setMergeMode(null)} />}
      {resolverConflicts && <ConflictResolverModal workspace={workspace} conflicts={resolverConflicts} onClose={() => { setResolverConflicts(null); onRefresh(); }} onResolved={(outcome) => { setResolverConflicts(null); onRefresh(); onNotify?.(outcome === "completed" ? "Merge completato." : "Merge annullato."); }} />}
    </div>
  );
}

function CommitBox({ workspace, status, onCommitted, onMerge }: { workspace: string; status: GitStatus; onCommitted: () => void; onMerge: (mode: "choose" | "from") => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canCommit = message.trim().length > 0 && status.changes.length > 0 && !busy;

  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [menuOpen]);

  async function commit(push: boolean) {
    if (!canCommit) return;
    setBusy(true);
    setError(null);
    setMenuOpen(false);
    try {
      await api.gitCommit(workspace, message, push);
      setMessage("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
      onCommitted();
    }
  }

  return (
    <div ref={rootRef} className="git-commit-box">
      <input type="text" value={message} disabled={busy} placeholder="Messaggio (Ctrl+Invio per eseguire il commit)"
        aria-label="Messaggio di commit" className="git-commit-input"
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void commit(false);
          }
        }} />
      <div className="git-commit-actions">
        <button type="button" className="git-commit-primary" disabled={!canCommit} onClick={() => void commit(false)}>
          {busy ? <span className="git-commit-pending" aria-hidden="true" /> : <CheckIcon className="h-4 w-4" />}
          <span>{busy ? "Commit…" : "Commit"}</span>
        </button>
        <button type="button" className="git-commit-more" disabled={busy} aria-haspopup="menu" aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)} title="Scegli Commit, Commit e push o Merge" aria-label="Altre opzioni di commit">
          <ChevronRightIcon className="git-commit-chevron h-3.5 w-3.5" />
        </button>
        {menuOpen && <div className="git-commit-menu" role="menu" aria-label="Opzioni di commit">
          <button type="button" role="menuitem" disabled={!canCommit} onClick={() => void commit(true)}>
            <CloudUpIcon className="h-4 w-4" />
            <span>Commit e push</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onMerge("choose"); }}>
            <MergeIcon className="h-4 w-4" />
            <span>Esegui merge</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onMerge("from"); }}>
            <MergeIcon className="h-4 w-4" />
            <span>Esegui merge da</span>
          </button>
        </div>}
      </div>
      {error && <div className="git-commit-error" role="alert">{error}</div>}
    </div>
  );
}
