import { useEffect, useRef, useState, type ReactNode } from "react";
import { listRecents, type RecentProject } from "../lib/recents";
import type { WorkspaceMode } from "../types";
import { basename } from "../types";
import { BrandWordmark } from "./BrandWordmark";
import { ChangeBadge } from "./ChangeBadge";
import { CheckIcon, ChevronRightIcon, FolderIcon, FolderOpenIcon, HelmIcon, InfoIcon, PlusIcon, RobotIcon, SettingsIcon, WindowIcon } from "./Icons";
import { UpdateMenu } from "./UpdateMenu";
import { WindowControls } from "./WindowControls";

type Props = {
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  workspace: string;
  maximized: boolean;
  modifiedCount: number;
  hasUnsavedChanges: boolean;
  autoCheckUpdates: boolean;
  onShowProjects: () => void;
  onOpenFolder: () => void;
  onNewProject: () => void;
  onNewWindow: () => void;
  onOpenRecent: (path: string) => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  onSaveAll: () => Promise<boolean>;
};

const pathKey = (path: string) => path.replace(/\\/g, "/").toLowerCase();

export function TitleBar({
  mode,
  onModeChange,
  workspace,
  maximized,
  modifiedCount,
  hasUnsavedChanges,
  autoCheckUpdates,
  onShowProjects,
  onOpenFolder,
  onNewProject,
  onNewWindow,
  onOpenRecent,
  onOpenSettings,
  onOpenAbout,
  onSaveAll,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    setRecents(listRecents());
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMenuOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [menuOpen]);

  useEffect(() => { setMenuOpen(false); }, [workspace]);

  const run = (action: () => void) => {
    setMenuOpen(false);
    action();
  };

  return (
    <header data-tauri-drag-region className="titlebar">
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-3">
        <BrandWordmark />
        <span data-tauri-drag-region className="text-[var(--secondary)]">/</span>
        <div ref={rootRef} className="project-switcher">
          <button type="button" className="workspace-picker project-switcher-main" onClick={() => { setMenuOpen(false); onOpenFolder(); }} title={`Apri una cartella come progetto · ${workspace}`}>
            <FolderOpenIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">{workspace ? basename(workspace) : "Progetti"}</span>
          </button>
          <button ref={toggleRef} type="button" className="project-switcher-toggle" aria-haspopup="menu" aria-expanded={menuOpen} title="Menu progetto" aria-label="Menu progetto" onClick={() => setMenuOpen((value) => !value)}>
            <ChevronRightIcon className="h-3.5 w-3.5 rotate-90" />
          </button>
          {menuOpen && (
            <div className="project-menu" role="menu" aria-label="Progetto">
              <button type="button" role="menuitem" className="project-menu-item" onClick={() => run(onNewProject)}>
                <PlusIcon className="h-4 w-4 shrink-0" />
                <span>Nuovo progetto vuoto</span>
              </button>
              <button type="button" role="menuitem" className="project-menu-item" onClick={() => run(onNewWindow)}>
                <WindowIcon className="h-4 w-4 shrink-0" />
                <span>Nuova finestra</span>
              </button>
              <div className="project-menu-section">Progetti recenti</div>
              {recents.length === 0 && <div className="project-menu-empty">Nessun progetto recente.</div>}
              {recents.map((recent) => (
                <button type="button" role="menuitem" key={recent.path} className="project-menu-item project-menu-recent" title={recent.path} onClick={() => run(() => onOpenRecent(recent.path))}>
                  <FolderIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{recent.name}</span>
                    <span className="block truncate text-xs text-[var(--muted)]">{recent.path}</span>
                  </span>
                  {pathKey(recent.path) === pathKey(workspace) && <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" aria-label="Progetto corrente" />}
                </button>
              ))}
              <div className="project-menu-divider" />
              <button type="button" role="menuitem" className="project-menu-item project-menu-all" onClick={() => run(onShowProjects)}>
                <FolderOpenIcon className="h-4 w-4 shrink-0" />
                <span>Tutti i progetti…</span>
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="mode-switch" role="group" aria-label="Modalità di lavoro">
        <ModeButton active={mode === "ai"} label="AGENT" title="AGENT · Assistente di programmazione (Ctrl+Shift+A)" onClick={() => onModeChange("ai")} icon={<RobotIcon className="h-[18px] w-[18px] shrink-0" />} />
        <ModeButton active={mode === "ide"} label="HELM" title={`HELM · Editor · ${modifiedCount} file modificati (Ctrl+Shift+H)`} onClick={() => onModeChange("ide")} icon={<HelmIcon className="h-[18px] w-[18px] shrink-0" />} count={modifiedCount} />
      </div>
      <div data-tauri-drag-region className="flex min-w-0 items-center justify-end self-stretch">
        <UpdateMenu autoCheck={autoCheckUpdates} hasUnsavedChanges={hasUnsavedChanges} onSaveAll={onSaveAll} />
        <button type="button" className="toolbar-icon-button" title="Impostazioni" aria-label="Impostazioni" onClick={onOpenSettings}>
          <SettingsIcon className="h-[18px] w-[18px]" />
        </button>
        <button type="button" className="toolbar-icon-button" title="Informazioni" aria-label="Informazioni" onClick={onOpenAbout}>
          <InfoIcon className="h-[18px] w-[18px]" />
        </button>
        <WindowControls maximized={maximized} />
      </div>
    </header>
  );
}

function ModeButton({ active, label, title, icon, onClick, count = 0 }: { active: boolean; label: string; title: string; icon: ReactNode; onClick: () => void; count?: number }) {
  return (
    <button type="button" title={title} aria-pressed={active} onClick={onClick} className={`mode-button ${active ? "is-active" : ""}`}>
      {icon}<span>{label}</span><ChangeBadge count={count} />
    </button>
  );
}
