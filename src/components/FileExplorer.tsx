import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { api } from "../lib/tauri";
import { ancestorDirectories, compactDirectory, dropOperations, isWithin, loadDirectoryChain, parentDirectory, remapExplorerPath, topLevelEntries, visibleEntries } from "../lib/explorer";
import { CHANGE_LABELS, type ChangeKind } from "../lib/gitStatus";
import type { DirEntry, FileOperation, WorkspaceMutation } from "../types";
import { CheckIcon, ChevronRightIcon, FilePlusIcon, FolderOpenIcon, FolderPickerIcon, PencilIcon, TrashIcon, XIcon } from "./Icons";
import { FileTypeIcon } from "./FileTypeIcon";
import { revealInExplorer } from "../lib/opener";

const DRAG_TYPE = "application/x-helmcode-entries";
const HOVER_EXPAND_DELAY = 600;
const sortEntries = (entries: DirEntry[]) => entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
type Props = {
  workspace: string; version: number; changes: ReadonlyMap<string, ChangeKind>; activePath: string | null;
  onOpen: (path: string) => void; createRequest: { id: number; kind: "file" | "folder" }; collapseRequest: number; onCreated: () => void;
  onMutate: (operations: FileOperation[]) => Promise<WorkspaceMutation | null>;
  revealRequest: { path: string; nonce: number } | null;
};

export function FileExplorer({ workspace, version, changes, activePath, onOpen, createRequest, collapseRequest, onCreated, onMutate, revealRequest }: Props) {
  const [selected, setSelected] = useState<DirEntry | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<{ parent: string; kind: "file" | "folder" } | null>(null);
  const [renaming, setRenaming] = useState<DirEntry | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; parent: string; entry: DirEntry | null } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [root, setRoot] = useState<DirEntry[]>([]);
  const [children, setChildren] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const contextTrigger = useRef<HTMLElement | null>(null);
  const lastRequest = useRef(createRequest.id);
  const workspaceRef = useRef(workspace);
  const expandedRef = useRef(expanded);
  const busyRef = useRef(false);
  const reloadRequest = useRef(0);
  const openingRequest = useRef(0);
  const anchorPath = useRef<string | null>(null);
  const dragging = useRef<{ workspace: string; entries: DirEntry[] } | null>(null);
  const dragHover = useRef<{ path: string; timer: number } | null>(null);
  const dragHoverRequest = useRef(0);
  workspaceRef.current = workspace;
  expandedRef.current = expanded;

  const clearDragHover = () => {
    ++dragHoverRequest.current;
    if (dragHover.current) window.clearTimeout(dragHover.current.timer);
    dragHover.current = null;
  };
  const endDrag = () => {
    clearDragHover();
    dragging.current = null;
    setDropTarget(null);
  };

  useEffect(() => () => clearDragHover(), [workspace]);

  const knownEntries = () => {
    const known = new Map<string, DirEntry>();
    root.forEach((entry) => known.set(entry.path, entry));
    Object.values(children).forEach((entries) => entries.forEach((entry) => known.set(entry.path, entry)));
    if (selected) known.set(selected.path, selected);
    return known;
  };
  const selection = (entry: DirEntry | null = selected) => {
    if (!entry) return [];
    const known = knownEntries();
    return topLevelEntries(selectedPaths.has(entry.path)
      ? Array.from(selectedPaths).flatMap((path) => known.has(path) ? [known.get(path)!] : []) : [entry]);
  };
  const destination = (entry: DirEntry | null) => entry?.isDir ? entry.path : entry ? parentDirectory(entry.path) : ".";
  const focusPath = (path: string, scroll = false) => requestAnimationFrame(() => {
    const row = Array.from(treeRef.current?.querySelectorAll<HTMLButtonElement>(".tree-row") ?? []).find((row) => row.title === path);
    if (scroll) row?.scrollIntoView({ block: "nearest" }); else row?.focus();
  });

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    ++reloadRequest.current;
    ++openingRequest.current;
    setLoading(true); setError(null); setRoot([]); setChildren({}); setExpanded(new Set());
    setSelected(null); setSelectedPaths(new Set()); setDraft(null); setRenaming(null); setBusy(false);
    busyRef.current = false; setMenu(null); setDropTarget(null); dragging.current = null; anchorPath.current = null;
    lastRequest.current = createRequest.id;
    void (async () => {
      try {
        const entries = await api.listDirectory(".");
        if (cancelled) return;
        setRoot(entries);
        if (entries.length === 1 && entries[0].isDir) {
          const chain = await loadDirectoryChain(entries[0], api.listDirectory, () => !cancelled);
          if (!cancelled) { setChildren(chain.children); setExpanded(new Set(chain.paths)); if (chain.leaf) focusPath(chain.leaf.path, true); }
        }
      } catch (reason: unknown) { if (!cancelled) setError(String(reason)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [workspace]);

  const reload = async (paths: Iterable<string>, currentWorkspace = workspace) => {
    const request = ++reloadRequest.current;
    const directories = Array.from(new Set(paths)).filter((path) => path !== ".");
    const entries = await api.listDirectory(".");
    const results = await Promise.all(directories.map(async (path) => {
      try { return [path, await api.listDirectory(path)] as const; } catch { return null; }
    }));
    if (workspaceRef.current !== currentWorkspace || request !== reloadRequest.current) return;
    const nextChildren: Record<string, DirEntry[]> = {};
    results.forEach((result) => { if (result) Object.defineProperty(nextChildren, result[0], { value: result[1], enumerable: true }); });
    setRoot(entries); setChildren(nextChildren);
  };
  useEffect(() => {
    if (version === 0 || !workspace || busyRef.current) return;
    const currentWorkspace = workspace;
    void reload(expandedRef.current, currentWorkspace).catch((reason: unknown) => { if (workspaceRef.current === currentWorkspace) setError(String(reason)); });
  }, [version]);
  useEffect(() => {
    if (!collapseRequest) return;
    setExpanded(new Set());
  }, [collapseRequest]);
  useEffect(() => {
    if (!revealRequest?.path) return;
    const currentWorkspace = workspace;
    const target = revealRequest.path;
    const directories = ancestorDirectories(target);
    let cancelled = false;
    void (async () => {
      try {
        const loaded: Record<string, DirEntry[]> = {};
        for (const directory of directories.length ? directories : ["."]) {
          const entries = await api.listDirectory(directory);
          if (cancelled || workspaceRef.current !== currentWorkspace) return;
          Object.defineProperty(loaded, directory, { value: entries, enumerable: true });
        }
        const leaf = Object.values(loaded).flat().find((entry) => entry.path === target && !entry.isDir);
        if (!leaf) return;
        setChildren((current) => ({ ...current, ...loaded }));
        setExpanded((current) => new Set([...current, ...directories]));
        setSelected(leaf); setSelectedPaths(new Set([leaf.path])); anchorPath.current = leaf.path;
        focusPath(leaf.path, true);
      } catch { }
    })();
    return () => { cancelled = true; };
  }, [revealRequest?.nonce]);

  const beginCreate = (parent: string, kind: "file" | "folder") => {
    if (busyRef.current) return;
    setMenu(null); setRenaming(null); setError(null); setName(""); setDraft({ parent, kind });
    if (parent !== ".") {
      setExpanded((current) => new Set([...current, parent]));
      const currentWorkspace = workspace;
      void api.listDirectory(parent).then((entries) => {
        if (workspaceRef.current === currentWorkspace) setChildren((current) => ({ ...current, [parent]: entries }));
      }).catch((reason: unknown) => { if (workspaceRef.current === currentWorkspace) setError(String(reason)); });
    }
  };
  useEffect(() => {
    if (lastRequest.current === createRequest.id) return;
    lastRequest.current = createRequest.id;
    beginCreate(destination(selected), createRequest.kind);
  }, [createRequest]);
  useEffect(() => {
    const input = renameInput.current;
    if (!input || !renaming) return;
    input.focus();
    const dot = !renaming.isDir ? renaming.name.lastIndexOf(".") : -1;
    input.setSelectionRange(0, dot > 0 ? dot : renaming.name.length);
  }, [renaming?.path]);
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(null); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); setMenu(null); contextTrigger.current?.focus(); } };
    const dismiss = () => setMenu(null);
    window.addEventListener("pointerdown", outside, true); window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", dismiss); window.addEventListener("blur", dismiss);
    return () => { window.removeEventListener("pointerdown", outside, true); window.removeEventListener("keydown", escape, true); window.removeEventListener("resize", dismiss); window.removeEventListener("blur", dismiss); };
  }, [menu]);
  const contextMenu = (event: MouseEvent, entry: DirEntry | null) => {
    event.preventDefault(); event.stopPropagation();
    if (busyRef.current) return;
    contextTrigger.current = event.currentTarget as HTMLElement;
    setSelected(entry);
    if (!entry || !selectedPaths.has(entry.path)) setSelectedPaths(new Set(entry ? [entry.path] : []));
    setMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 240)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - (entry ? 240 : 160))), parent: destination(entry), entry });
  };
  const revealEntry = (entry: DirEntry | null) => {
    if (!workspace) return;
    const absolute = entry ? `${workspace.replace(/[\\/]+$/, "")}/${entry.path}` : workspace;
    setMenu(null);
    void revealInExplorer(absolute).catch((reason: unknown) => setError(String(reason)));
  };

  const mutate = async (operations: FileOperation[]) => {
    if (busyRef.current || !operations.length) return null;
    const currentWorkspace = workspace;
    busyRef.current = true; setBusy(true); setMenu(null); setDropTarget(null); setError(null);
    ++openingRequest.current; ++reloadRequest.current;
    try {
      const result = await onMutate(operations);
      if (!result || workspaceRef.current !== currentWorkspace) return null;
      const survives = (path: string) => !result.deleted.some((deleted) => isWithin(path, deleted));
      const map = (path: string) => remapExplorerPath(path, result.moves);
      const nextExpanded = new Set(Array.from(expandedRef.current).filter(survives).map(map));
      result.moves.forEach((move) => { const parent = parentDirectory(move.newPath); if (parent !== ".") nextExpanded.add(parent); });
      setExpanded(nextExpanded);
      setSelectedPaths((current) => new Set(Array.from(current).filter(survives).map(map)));
      setSelected((current) => current && survives(current.path) ? { ...current, path: map(current.path), name: map(current.path).split("/").pop()! } : null);
      if (anchorPath.current) anchorPath.current = survives(anchorPath.current) ? map(anchorPath.current) : null;
      await reload(nextExpanded, currentWorkspace);
      return result;
    } catch (reason: unknown) { if (workspaceRef.current === currentWorkspace) setError(String(reason)); return null; }
    finally { if (workspaceRef.current === currentWorkspace) { busyRef.current = false; setBusy(false); } }
  };
  const beginRename = (entry: DirEntry) => {
    if (busyRef.current) return;
    setMenu(null); setDraft(null); setError(null); setSelected(entry); setSelectedPaths(new Set([entry.path])); setName(entry.name); setRenaming(entry);
  };
  const rename = async () => {
    if (!renaming || busyRef.current || !name.trim()) return;
    const entry = renaming; const trimmed = name.trim();
    if (trimmed === entry.name) { setRenaming(null); focusPath(entry.path); return; }
    if (/[\\/]/.test(trimmed)) { setError("Il nome non può contenere separatori di cartella."); return; }
    const parent = parentDirectory(entry.path); const newPath = parent === "." ? trimmed : `${parent}/${trimmed}`;
    const result = await mutate([{ kind: "move", path: entry.path, newPath }]);
    if (result) { setRenaming(null); focusPath(newPath); }
  };
  const remove = async (entry = selected) => {
    const entries = selection(entry);
    if (entries.length) await mutate(entries.map((item) => ({ kind: "delete", path: item.path })));
  };
  const create = async () => {
    if (!draft || busyRef.current || !name.trim()) return;
    const currentWorkspace = workspace; const creation = draft;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const entry = await api.createEntry(workspace, creation.parent, name.trim(), creation.kind === "folder");
      if (workspaceRef.current !== currentWorkspace) return;
      const insert = (entries: DirEntry[]) => sortEntries([...entries.filter((item) => item.path !== entry.path), entry]);
      if (creation.parent === ".") setRoot(insert);
      else setChildren((current) => ({ ...current, [creation.parent]: insert(Object.hasOwn(current, creation.parent) ? current[creation.parent] : []) }));
      setSelected(entry); setSelectedPaths(new Set([entry.path])); anchorPath.current = entry.path; setDraft(null); onCreated();
      if (!entry.isDir) onOpen(entry.path);
    } catch (reason: unknown) { if (workspaceRef.current === currentWorkspace) setError(String(reason)); }
    finally { if (workspaceRef.current === currentWorkspace) { busyRef.current = false; setBusy(false); } }
  };

  const renderCreate = (parent: string, depth: number) => draft?.parent === parent ? (
    <form className="explorer-create" style={{ paddingLeft: 6 + depth * 10 }} onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <FileTypeIcon path={name || (draft.kind === "file" ? "new.txt" : "new")} isDir={draft.kind === "folder"} className="h-4 w-4 shrink-0" />
      <input autoFocus aria-label={draft.kind === "file" ? "Nome nuovo file" : "Nome nuova cartella"} value={name} onChange={(event) => setName(event.target.value)} spellCheck={false} disabled={busy}
        placeholder={draft.kind === "file" ? "nome-file.ext" : "nome-cartella"} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); setDraft(null); setError(null); } }} />
      <button type="submit" className="icon-button" disabled={busy || !name.trim()} title="Crea" aria-label="Conferma creazione"><CheckIcon className="h-4 w-4" /></button>
      <button type="button" className="icon-button" disabled={busy} onClick={() => { setDraft(null); setError(null); }} title="Annulla" aria-label="Annulla creazione"><XIcon className="h-4 w-4" /></button>
    </form>
  ) : null;
  const renderRename = (entry: DirEntry, depth: number) => renaming?.path === entry.path ? (
    <form className="explorer-create explorer-rename" style={{ paddingLeft: 6 + depth * 10 }} onSubmit={(event) => { event.preventDefault(); void rename(); }}>
      <FileTypeIcon path={name || entry.name} isDir={entry.isDir} className="h-4 w-4 shrink-0" />
      <input ref={renameInput} aria-label="Nuovo nome" value={name} onChange={(event) => setName(event.target.value)} spellCheck={false} disabled={busy} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); setRenaming(null); setError(null); focusPath(entry.path); } }} />
      <button type="submit" className="icon-button" disabled={busy || !name.trim()} title="Rinomina" aria-label="Conferma rinomina"><CheckIcon className="h-4 w-4" /></button>
      <button type="button" className="icon-button" disabled={busy} title="Annulla" aria-label="Annulla rinomina" onClick={() => { setRenaming(null); setError(null); focusPath(entry.path); }}><XIcon className="h-4 w-4" /></button>
    </form>
  ) : null;

  async function toggle(entry: DirEntry) {
    if (busyRef.current) return;
    const request = ++openingRequest.current;
    if (expandedRef.current.has(entry.path)) { setExpanded((current) => { const next = new Set(current); next.delete(entry.path); return next; }); return; }
    const currentWorkspace = workspace;
    try {
      const chain = await loadDirectoryChain(entry, (path) => Object.hasOwn(children, path) ? Promise.resolve(children[path]) : api.listDirectory(path),
        () => workspaceRef.current === currentWorkspace && openingRequest.current === request);
      if (workspaceRef.current !== currentWorkspace || openingRequest.current !== request) return;
      setChildren((current) => ({ ...current, ...chain.children })); setExpanded((current) => new Set([...current, ...chain.paths]));
      if (chain.leaf && chain.paths.length > 1) { setSelected(chain.leaf); setSelectedPaths(new Set([chain.leaf.path])); anchorPath.current = chain.leaf.path; focusPath(chain.leaf.path, true); }
    } catch (reason: unknown) { if (workspaceRef.current === currentWorkspace && openingRequest.current === request) setError(String(reason)); }
  }
  const clickEntry = (entry: DirEntry, event: MouseEvent) => {
    if (busyRef.current) return;
    setSelected(entry);
    if (event.shiftKey && anchorPath.current) {
      const entries = visibleEntries(root, expanded, children);
      const from = entries.findIndex((item) => item.path === anchorPath.current), to = entries.findIndex((item) => item.path === entry.path);
      if (from >= 0 && to >= 0) { const paths = entries.slice(Math.min(from, to), Math.max(from, to) + 1).map((item) => item.path); setSelectedPaths(new Set([...(event.ctrlKey || event.metaKey ? selectedPaths : []), ...paths])); return; }
    }
    if (event.ctrlKey || event.metaKey) {
      setSelectedPaths((current) => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; }); anchorPath.current = entry.path; return;
    }
    setSelectedPaths(new Set([entry.path])); anchorPath.current = entry.path;
    if (entry.isDir) void toggle(entry); else onOpen(entry.path);
  };
  const treeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (busyRef.current || (event.target as HTMLElement).closest("input, form")) return;
    if (event.key === "F2" && selected && selection().length === 1) { event.preventDefault(); beginRename(selected); }
    else if (event.key === "Delete" && selected) { event.preventDefault(); void remove(); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") { event.preventDefault(); setSelectedPaths(new Set(visibleEntries(root, expanded, children).map((entry) => entry.path))); }
  };
  const dragStart = (event: DragEvent, entry: DirEntry) => {
    if (busyRef.current || draft || renaming) { event.preventDefault(); return; }
    event.stopPropagation();
    clearDragHover();
    const entries = selection(entry); dragging.current = { workspace, entries }; setSelected(entry);
    if (!selectedPaths.has(entry.path)) setSelectedPaths(new Set([entry.path]));
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ workspace, paths: entries.map((item) => item.path) })); setMenu(null);
  };
  const dragEntries = (event: DragEvent): DirEntry[] => {
    if (dragging.current?.workspace === workspace) return dragging.current.entries;
    try {
      const payload: unknown = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
      if (!payload || typeof payload !== "object" || !("workspace" in payload) || payload.workspace !== workspace || !("paths" in payload) || !Array.isArray(payload.paths)) return [];
      const known = knownEntries(); return payload.paths.flatMap((path: unknown) => typeof path === "string" && known.has(path) ? [known.get(path)!] : []);
    } catch { return []; }
  };
  const expandOnDragHover = (entry: DirEntry | null) => {
    if (!entry?.isDir || expandedRef.current.has(entry.path)) { clearDragHover(); return; }
    if (dragHover.current?.path === entry.path) return;
    clearDragHover();
    const currentWorkspace = workspace;
    const request = dragHoverRequest.current;
    const isCurrent = () => workspaceRef.current === currentWorkspace && dragHoverRequest.current === request && !busyRef.current;
    const timer = window.setTimeout(() => {
      void loadDirectoryChain(entry, (path) => Object.hasOwn(children, path) ? Promise.resolve(children[path]) : api.listDirectory(path), isCurrent)
        .then((chain) => {
          if (!isCurrent()) return;
          setChildren((current) => ({ ...current, ...chain.children }));
          setExpanded((current) => new Set([...current, ...chain.paths]));
        }).catch((reason: unknown) => { if (isCurrent()) setError(String(reason)); });
    }, HOVER_EXPAND_DELAY);
    dragHover.current = { path: entry.path, timer };
  };
  const dragOver = (event: DragEvent, entry: DirEntry | null) => {
    if (busyRef.current || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault(); event.stopPropagation();
    const entries = dragEntries(event);
    try {
      const parent = destination(entry);
      if (!entries.length || !dropOperations(entries, parent).length) { event.dataTransfer.dropEffect = "none"; setDropTarget(null); clearDragHover(); return; }
      event.dataTransfer.dropEffect = "move"; setDropTarget(parent);
      expandOnDragHover(entry);
    } catch { event.dataTransfer.dropEffect = "none"; setDropTarget(null); clearDragHover(); }
  };
  const drop = (event: DragEvent, entry: DirEntry | null) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault(); event.stopPropagation(); setDropTarget(null);
    const entries = dragEntries(event); endDrag();
    if (!entries.length || busyRef.current) return;
    try { void mutate(dropOperations(entries, destination(entry))); } catch (reason: unknown) { setError(String(reason)); }
  };

  return <div className="flex min-h-0 flex-1 flex-col" aria-busy={busy}>
    <div ref={treeRef} tabIndex={0} className="scroll-area explorer-tree min-h-0 flex-1 overflow-auto px-1.5 py-2" data-drop-root={dropTarget === "." || undefined}
      onContextMenu={(event) => contextMenu(event, null)} onKeyDown={treeKeyDown} onDragOver={(event) => dragOver(event, null)} onDrop={(event) => drop(event, null)}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setDropTarget(null); clearDragHover(); } }}
      onClick={(event) => { if (!(event.target as HTMLElement).closest("button, input, form")) { setSelected(null); setSelectedPaths(new Set()); } }}>
      {loading && <div className="px-3 py-4 text-[13px] text-[var(--muted)]">Caricamento…</div>}
      {busy && <div className="explorer-busy" role="status">Aggiornamento del progetto…</div>}
      {error && <div role="alert" className="mx-1.5 rounded-md border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-[var(--danger)]">{error}</div>}
      {!loading && !error && !draft && root.length === 0 && <div className="px-3 py-4 text-[13px] text-[var(--muted)]">Nessun file visibile.</div>}
      {renderCreate(".", 0)}
      <Tree entries={root} depth={0} expanded={expanded} children={children} changes={changes} activePath={activePath}
        onClick={clickEntry} onFocus={setSelected} selectedPaths={selectedPaths} onContextMenu={contextMenu} renderCreate={renderCreate} renderRename={renderRename}
        busy={busy} dropTarget={dropTarget} onDragStart={dragStart} onDragOver={dragOver} onDrop={drop} onDragEnd={endDrag} />
    </div>
    {menu && <div ref={menuRef} className="explorer-context-menu" role="menu" aria-label="Azioni Explorer" style={{ left: menu.x, top: menu.y }} onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }}>
      <button type="button" role="menuitem" onClick={() => beginCreate(menu.parent, "file")}><FilePlusIcon className="h-[18px] w-[18px]" />Nuovo file</button>
      <button type="button" role="menuitem" onClick={() => beginCreate(menu.parent, "folder")}><FolderPickerIcon className="h-[18px] w-[18px]" />Nuova cartella</button>
      <div className="explorer-menu-separator" role="separator" />
      <button type="button" role="menuitem" onClick={() => revealEntry(menu.entry)}><FolderOpenIcon className="h-[18px] w-[18px]" />Visualizza in Esplora file</button>
      {menu.entry && <><div className="explorer-menu-separator" role="separator" />
        <button type="button" role="menuitem" disabled={selection(menu.entry).length !== 1} onClick={() => beginRename(menu.entry!)}><PencilIcon className="h-[18px] w-[18px]" /><span>Rinomina</span><kbd>F2</kbd></button>
        <button type="button" role="menuitem" className="is-danger" onClick={() => void remove(menu.entry)}><TrashIcon className="h-[18px] w-[18px]" /><span>{selection(menu.entry).length > 1 ? `Cancella ${selection(menu.entry).length} elementi` : "Cancella"}</span><kbd>Del</kbd></button>
      </>}
    </div>}
  </div>;
}

type TreeProps = {
  entries: DirEntry[]; depth: number; expanded: Set<string>; children: Record<string, DirEntry[]>; changes: ReadonlyMap<string, ChangeKind>; activePath: string | null;
  onClick: (entry: DirEntry, event: MouseEvent) => void; onFocus: (entry: DirEntry) => void; selectedPaths: Set<string>;
  onContextMenu: (event: MouseEvent, entry: DirEntry) => void; renderCreate: (parent: string, depth: number) => ReactNode; renderRename: (entry: DirEntry, depth: number) => ReactNode;
  busy: boolean; dropTarget: string | null; onDragStart: (event: DragEvent, entry: DirEntry) => void; onDragOver: (event: DragEvent, entry: DirEntry | null) => void;
  onDrop: (event: DragEvent, entry: DirEntry | null) => void; onDragEnd: () => void;
};
function Tree(props: TreeProps) {
  const { entries, depth, expanded, children, changes, activePath, onClick, onFocus, selectedPaths, onContextMenu, renderCreate, renderRename, busy, dropTarget, onDragStart, onDragOver, onDrop, onDragEnd } = props;
  return <>{entries.map((entry) => {
    const { label, leaf } = compactDirectory(entry, expanded, children);
    const isOpen = expanded.has(leaf.path), change = changes.get(leaf.path);
    return <div key={entry.path}>
      {renderRename(leaf, depth) ?? <button type="button" disabled={busy} draggable={!busy}
        onClick={(event) => onClick(leaf, event)} onFocus={() => onFocus(leaf)} onContextMenu={(event) => onContextMenu(event, leaf)}
        onDragStart={(event) => onDragStart(event, leaf)} onDragOver={(event) => onDragOver(event, leaf)} onDrop={(event) => onDrop(event, leaf)} onDragEnd={onDragEnd}
        aria-current={activePath === leaf.path ? "true" : undefined} aria-expanded={leaf.isDir ? isOpen : undefined}
        data-selected={selectedPaths.has(leaf.path) || undefined} data-drop-target={dropTarget === leaf.path || undefined}
        className="group tree-row" style={{ paddingLeft: `${6 + depth * 10}px` }} title={leaf.path}>
        {leaf.isDir ? <ChevronRightIcon className={`h-3 w-3 shrink-0 text-[var(--muted)] transition-transform ${isOpen ? "rotate-90" : ""}`} /> : <span className="w-3 shrink-0" />}
        <FileTypeIcon path={entry.path} isDir={leaf.isDir} open={isOpen} className="h-4 w-4 shrink-0" />
        <span className={`truncate${change ? ` change-${change}` : ""}`}>{label}</span>
        {change && <span className={`change-dot change-${change} ml-auto`} title={CHANGE_LABELS[change]} aria-label={CHANGE_LABELS[change]} />}
      </button>}
      {leaf.isDir && isOpen && <>{renderCreate(leaf.path, depth + 1)}<Tree {...props} entries={Object.hasOwn(children, leaf.path) ? children[leaf.path] : []} depth={depth + 1} /></>}
    </div>;
  })}</>;
}
