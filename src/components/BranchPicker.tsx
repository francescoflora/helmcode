import { useEffect, useRef, useState } from "react";
import { api } from "../lib/tauri";
import { relativeTime } from "../lib/relativeTime";
import type { GitBranch } from "../types";
import { CheckIcon, ChevronRightIcon, CloudIcon, GitBranchIcon, PlusIcon, StatusBranchIcon } from "./Icons";
import { CreateBranchModal } from "./CreateBranchModal";

type Props = {
  workspace: string;
  version: number;
  current: string;
  variant: "panel" | "status";
  disabled?: boolean;
  hasChanges?: boolean;
  onBeforeCheckout?: () => boolean | Promise<boolean>;
  onSaveAll?: () => Promise<boolean>;
  onNotify?: (message: string) => void;
  onChanged?: () => void;
  badge?: string;
  className?: string;
};

export function BranchPicker({ workspace, version, current, variant, disabled, hasChanges, onBeforeCheckout, onSaveAll, onNotify, onChanged, badge, className }: Props) {
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    if (!workspace) { setBranches([]); return; }
    api.gitBranches(workspace)
      .then((value) => { if (!cancelled) setBranches(value); })
      .catch((reason: unknown) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [workspace, version, open]);

  useEffect(() => { setOpen(false); setCreating(false); setBranches([]); setError(null); }, [workspace]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  async function select(branch: GitBranch) {
    if (pending) return;
    if (!branch.remote && branch.name === current) { setOpen(false); return; }
    if (onBeforeCheckout && !(await onBeforeCheckout())) return;
    setPending(branch.name);
    setError(null);
    try {
      await api.gitCheckout(workspace, branch.name, branch.remote);
      setOpen(false);
      onChanged?.();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(null);
    }
  }

  const local = branches.filter((branch) => !branch.remote);
  const remote = branches.filter((branch) => branch.remote);
  const busy = Boolean(pending) || Boolean(disabled);
  const label = pending ?? (current || "HEAD");

  return (
    <div ref={rootRef} className={`branch-picker ${variant === "status" ? "is-status" : ""} ${className ?? ""}`.trim()}>
      <button ref={triggerRef} type="button" disabled={busy} aria-haspopup="menu" aria-expanded={open}
        title="Passa a un branch locale o remoto" aria-label={`Branch Git attuale: ${label}${badge ? ". Modifiche non committate" : ""}. Seleziona un branch`}
        onClick={() => setOpen((value) => !value)}
        className={`branch-picker-trigger ${variant === "status" ? "status-item" : ""}`.trim()}>
        {variant === "status" ? <StatusBranchIcon /> : <GitBranchIcon className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
        <span className="branch-picker-label">{label}{badge && <span className="branch-picker-badge" aria-hidden="true">{badge}</span>}</span>
        {variant !== "status" && <ChevronRightIcon className="branch-picker-chevron h-3 w-3 shrink-0 rotate-90" />}
      </button>
      {open && <div className={`branch-picker-menu ${variant === "status" ? "is-status" : ""}`.trim()} role="menu" aria-label="Seleziona branch"
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          if (!buttons.length) return;
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }}>
        <button type="button" role="menuitem" className="branch-picker-create" disabled={Boolean(pending)}
          onClick={() => { setOpen(false); setCreating(true); }}>
          <PlusIcon className="h-4 w-4 shrink-0" />
          <span>Nuovo branch…</span>
        </button>
        {local.length > 0 && <div className="branch-picker-section" role="presentation">Branch locali</div>}
        {local.map((branch, index) => <BranchItem key={`local:${branch.name}`} branch={branch} current={current} pending={pending} autoFocus={!local.some((item) => item.name === current) && index === 0} onSelect={select} />)}
        {remote.length > 0 && <>
          <div className="branch-picker-section" role="presentation">Branch remoti</div>
          {remote.map((branch) => <BranchItem key={`remote:${branch.name}`} branch={branch} current={current} pending={pending} autoFocus={false} onSelect={select} />)}
        </>}
        {branches.length === 0 && !error && <div className="branch-picker-empty" role="status">Lettura branch…</div>}
        {error && <div className="branch-picker-error" role="alert">{error}</div>}
      </div>}
      {creating && <CreateBranchModal workspace={workspace} current={current} branches={branches}
        hasChanges={Boolean(hasChanges)} onSaveAll={onSaveAll ?? (async () => true)}
        onCreated={(status, stashed) => {
          setCreating(false);
          onNotify?.(stashed ? `Branch ${status.branch} creato. Modifiche conservate nello stash.` : `Branch ${status.branch} creato.`);
          onChanged?.();
        }}
        onClose={() => setCreating(false)} />}
    </div>
  );
}

function BranchItem({ branch, current, pending, autoFocus, onSelect }: {
  branch: GitBranch; current: string; pending: string | null; autoFocus: boolean; onSelect: (branch: GitBranch) => Promise<void>;
}) {
  const active = !branch.remote && branch.name === current;
  const date = relativeTime(branch.date);
  const meta = [branch.author, branch.shortHash, branch.subject].filter(Boolean).join(" • ");
  const fullDate = branch.date ? new Date(branch.date).toLocaleString("it-IT") : undefined;
  return <button type="button" role="menuitemradio" aria-checked={active} autoFocus={active || autoFocus}
    disabled={Boolean(pending)} onClick={() => void onSelect(branch)}
    className={`branch-picker-item ${active ? "is-current" : ""}`.trim()}>
    <span className="branch-picker-item-head">
      {branch.remote ? <CloudIcon className="h-4 w-4 shrink-0" /> : <GitBranchIcon className="h-4 w-4 shrink-0" />}
      <span className="branch-picker-item-name">{branch.name}</span>
      {date && <span className="branch-picker-item-date" title={fullDate}>{date}</span>}
      {pending === branch.name
        ? <span className="branch-picker-pending" aria-label="Cambio branch in corso" />
        : active && <CheckIcon className="ml-auto h-3.5 w-3.5 shrink-0" />}
    </span>
    {meta && <span className="branch-picker-item-meta" title={fullDate}>{meta}</span>}
  </button>;
}
