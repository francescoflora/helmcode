import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GitFileDiff } from "../types";
import { DiffTable } from "./DiffTable";
import { GitBranchIcon } from "./Icons";

type Props = { workspace: string; path: string; content?: string; version: number; onScroller?: (element: HTMLElement | null) => void };

export function GitDiff({ workspace, path, content, version, onScroller }: Props) {
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const identity = useRef("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const nextIdentity = `${workspace}\0${path}`;
    if (identity.current !== nextIdentity) {
      identity.current = nextIdentity;
      setDiff(null);
    }
    const timer = window.setTimeout(() => {
      invoke<GitFileDiff>("git_file_diff", { expectedWorkspace: workspace, path, content: content ?? null })
        .then((result) => { if (!cancelled) setDiff(result); })
        .catch((reason: unknown) => { if (!cancelled) setError(String(reason)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [workspace, path, content, version]);

  return (
    <section className="git-diff flex min-h-0 flex-1 flex-col bg-[var(--color-canvas)]" aria-label={`Differenze Git di ${path}`}>
      <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--overlay)_6%,transparent)] px-4 text-xs text-[var(--muted)]">
        <GitBranchIcon className="h-4.5 w-4.5" />
        <span>HEAD → {content === undefined ? "file su disco" : "file attuale"}</span>
        {diff && <span className="ml-auto flex gap-2 font-mono" aria-busy={loading}><span className="text-[var(--accent)]">+{diff.added}</span><span className="text-[var(--danger)]">−{diff.removed}</span></span>}
      </div>
      {loading && !diff ? <div role="status" className="p-5 text-[13px] text-[var(--muted)]">Calcolo differenze…</div>
        : error ? <div role="alert" className="p-5 text-[13px] leading-relaxed text-[var(--danger)]">{error}</div>
        : !diff || diff.added + diff.removed === 0 ? <div className="grid flex-1 place-items-center p-6 text-[13px] text-[var(--muted)]">Nessuna differenza rispetto a HEAD.</div>
        : <DiffTable lines={diff.lines} path={path} scrollKey={`${workspace}\0${path}`} onScroller={onScroller} />}
    </section>
  );
}
