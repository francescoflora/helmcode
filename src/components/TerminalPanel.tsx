import { lazy, Suspense, useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { readStored, writeStored } from "../lib/storage";
import type { TerminalTab } from "../types";
import { ArrowUpIcon, PencilIcon, PlusIcon, RefreshIcon, TerminalIcon, TrashIcon, XIcon } from "./Icons";

const TerminalSession = lazy(() => import("./TerminalSession").then((module) => ({ default: module.TerminalSession })));

type Props = { open: boolean; active: boolean; createRequest: number; focusRequest: number; onHide: () => void };
type Sessions = { items: TerminalTab[]; selected: string | null };

export function TerminalPanel({ open, active, createRequest, focusRequest, onHide }: Props) {
  const [sessions, setSessions] = useState<Sessions>({ items: [], selected: null });
  const [height, setHeight] = useState(() => Math.min(600, Math.max(160, readStored<number>("helmcode.terminals.height", 280))));
  const [maximized, setMaximized] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const nextNumber = useRef(0);
  const initialized = useRef(false);
  const lastRequest = useRef(createRequest);
  const cancelRename = useRef(false);
  const panel = useRef<HTMLElement>(null);
  const resizeStart = useRef<{ y: number; height: number; max: number } | null>(null);
  const selected = sessions.items.find((item) => item.id === sessions.selected);

  const create = useCallback(() => {
    const terminal: TerminalTab = { id: crypto.randomUUID(), title: `PowerShell ${++nextNumber.current}`, kind: "shell" };
    setSessions((current) => ({ items: [...current.items, terminal], selected: terminal.id }));
  }, []);

  useEffect(() => {
    if (lastRequest.current !== createRequest) {
      lastRequest.current = createRequest;
      initialized.current = true;
      create();
    } else if (open && !initialized.current) {
      initialized.current = true;
      create();
    }
  }, [open, createRequest, create]);
  useEffect(() => writeStored("helmcode.terminals.height", height), [height]);
  useEffect(() => { if (!open) setMaximized(false); }, [open]);
  useEffect(() => {
    if (!open || !active || !focusRequest) return;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLTextAreaElement>(".terminal-pane:not([hidden]) .xterm-helper-textarea")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, active, focusRequest]);

  const close = (id: string) => {
    setSessions((current) => {
      const index = current.items.findIndex((item) => item.id === id);
      const items = current.items.filter((item) => item.id !== id);
      return { items, selected: current.selected === id ? items[Math.min(index, items.length - 1)]?.id ?? null : current.selected };
    });
    if (renaming === id) setRenaming(null);
  };
  const exited = useCallback((id: string) => {
    setSessions((current) => ({ ...current, items: current.items.map((item) => item.id === id ? { ...item, exited: true } : item) }));
  }, []);
  const restart = () => {
    if (!selected) return;
    const id = crypto.randomUUID();
    setSessions((current) => ({ items: current.items.map((item) => item.id === selected.id ? { ...item, id, exited: false } : item), selected: id }));
  };
  const startRename = (item: TerminalTab) => {
    cancelRename.current = false;
    setRenaming(item.id);
    setName(item.title);
  };
  const saveName = () => {
    const title = name.trim();
    if (!cancelRename.current && title) {
      setSessions((current) => ({ ...current, items: current.items.map((item) => item.id === renaming ? { ...item, title } : item) }));
    }
    setRenaming(null);
  };
  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const containerHeight = panel.current?.parentElement?.clientHeight ?? 700;
    resizeStart.current = { y: event.clientY, height: panel.current?.clientHeight ?? height, max: Math.max(160, containerHeight - 180) };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  return (
    <section ref={panel} className={`terminal-panel ${maximized ? "is-maximized" : ""}`} hidden={!open} style={maximized ? undefined : { height }} aria-label="Terminali del progetto">
      <div className="terminal-resizer" role="separator" aria-label="Ridimensiona terminali" aria-orientation="horizontal" tabIndex={0}
        onPointerDown={beginResize}
        onPointerMove={(event) => { const start = resizeStart.current; if (start) setHeight(Math.min(start.max, Math.max(160, start.height + start.y - event.clientY))); }}
        onPointerUp={() => { resizeStart.current = null; }} onPointerCancel={() => { resizeStart.current = null; }} onLostPointerCapture={() => { resizeStart.current = null; }}
        onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); const max = Math.max(160, (panel.current?.parentElement?.clientHeight ?? 700) - 180); setHeight((current) => Math.min(max, Math.max(160, current + (event.key === "ArrowUp" ? 24 : -24)))); } }} />
      <header className="terminal-toolbar">
        <span className="terminal-heading">Terminale</span>
        <div className="terminal-tabs scroll-area" role="tablist" aria-label="Sessioni terminale">
          {sessions.items.map((item) => (
            <div className={`terminal-tab ${sessions.selected === item.id ? "is-active" : ""}`} key={item.id}
              onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); close(item.id); } }}
              onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}>
              {renaming === item.id ? (
                <input className="terminal-name-input" aria-label="Nome terminale" value={name} onChange={(event) => setName(event.target.value)} autoFocus maxLength={80}
                  onFocus={(event) => event.currentTarget.select()} onBlur={saveName}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveName(); } if (event.key === "Escape") { event.preventDefault(); cancelRename.current = true; setRenaming(null); } }} />
              ) : (
                <button type="button" role="tab" aria-selected={sessions.selected === item.id} aria-controls={`terminal-${item.id}`} id={`terminal-tab-${item.id}`}
                  className="terminal-tab-select" onClick={() => setSessions((current) => ({ ...current, selected: item.id }))} onDoubleClick={() => startRename(item)} title={`${item.title}${item.exited ? " · Terminato" : ""}`}>
                  <TerminalIcon className="h-4 w-4 shrink-0" /><span className="truncate">{item.title}</span>{item.exited && <span className="terminal-ended">Terminato</span>}
                </button>
              )}
              <button type="button" className="icon-button terminal-tab-close" aria-label={`Chiudi ${item.title}`} title={`Chiudi ${item.title}`} onClick={() => close(item.id)}><XIcon className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
        <div className="terminal-actions">
          <button type="button" className="icon-button" onClick={create} aria-label="Nuovo terminale" title="Nuovo terminale (Ctrl+Shift+`)"><PlusIcon className="h-[18px] w-[18px]" /></button>
          <button type="button" className="icon-button" disabled={!selected} onClick={() => selected && startRename(selected)} aria-label="Rinomina terminale" title="Rinomina terminale"><PencilIcon className="h-4 w-4" /></button>
          <button type="button" className="icon-button" disabled={!selected} onClick={() => selected && close(selected.id)} aria-label="Chiudi terminale attivo" title="Chiudi terminale attivo"><TrashIcon className="h-4 w-4" /></button>
          <button type="button" className="icon-button" aria-pressed={maximized} onClick={() => setMaximized((value) => !value)} aria-label={maximized ? "Ripristina terminale" : "Espandi terminale"} title={maximized ? "Ripristina terminale" : "Espandi terminale"}>{maximized ? <ArrowUpIcon className="h-4 w-4 rotate-180" /> : <ArrowUpIcon className="h-4 w-4" />}</button>
          <button type="button" className="icon-button" onClick={onHide} aria-label="Nascondi terminali" title="Nascondi terminali (Ctrl+`)"><XIcon className="h-[18px] w-[18px]" /></button>
        </div>
      </header>
      <div className="terminal-panes">
        {sessions.items.length === 0 && <div className="terminal-empty"><TerminalIcon className="h-7 w-7" /><p>Nessun terminale aperto</p><button type="button" className="ghost-button" onClick={create}><PlusIcon className="h-4 w-4" />Nuovo terminale</button></div>}
        {sessions.items.map((item) => (
          <div key={item.id} className="terminal-pane" role="tabpanel" data-session-id={item.id} id={`terminal-${item.id}`} aria-labelledby={`terminal-tab-${item.id}`} hidden={sessions.selected !== item.id}>
            <Suspense fallback={<div className="panel-empty">Apertura terminale…</div>}><TerminalSession tab={item} active={active && open && sessions.selected === item.id} onExit={exited} /></Suspense>
            {item.exited && <div className="terminal-exit-notice"><span>Sessione terminata</span><button type="button" className="ghost-button" onClick={restart}><RefreshIcon className="h-4 w-4" />Riavvia</button></div>}
          </div>
        ))}
      </div>
    </section>
  );
}
