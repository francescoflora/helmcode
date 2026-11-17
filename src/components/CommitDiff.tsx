import { useEffect, useState } from "react";
import { api } from "../lib/tauri";
import type { GitFileDiff } from "../types";
import { DiffTable } from "./DiffTable";
import { ArrowLeftIcon, GitBranchIcon } from "./Icons";

type Props = {
  workspace: string;
  hash: string;
  shortHash: string;
  path: string;
  oldPath: string | null;
  onBack: () => void;
};

export function CommitDiff({ workspace, hash, shortHash, path, oldPath, onBack }: Props) {
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDiff(null);
    api.gitCommitFileDiff(workspace, hash, path, oldPath)
      .then((result) => { if (!cancelled) setDiff(result); })
      .catch((reason: unknown) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspace, hash, path, oldPath]);

  return (
    <div className="git-commit-diff">
      <div className="git-commit-diff-header">
        <button type="button" className="icon-button" onClick={onBack} title="Torna al grafo" aria-label="Torna al grafo">
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <GitBranchIcon className="h-4.5 w-4.5 text-[var(--accent)]" />
        <span className="git-commit-diff-path" title={path}>{path}</span>
        <span className="git-commit-diff-ref">{shortHash}</span>
        {diff && <span className="ml-auto flex gap-2 font-mono" aria-busy={loading}><span className="text-[var(--accent)]">+{diff.added}</span><span className="text-[var(--danger)]">−{diff.removed}</span></span>}
      </div>
      {loading && !diff ? <div role="status" className="p-5 text-[13px] text-[var(--muted)]">Calcolo differenze…</div>
        : error ? <div role="alert" className="p-5 text-[13px] leading-relaxed text-[var(--danger)]">{error}</div>
        : !diff || diff.added + diff.removed === 0 ? <div className="grid flex-1 place-items-center p-6 text-[13px] text-[var(--muted)]">Nessuna differenza in questo commit.</div>
        : <DiffTable lines={diff.lines} path={path} scrollKey={`${hash}\0${path}`} />}
    </div>
  );
}
