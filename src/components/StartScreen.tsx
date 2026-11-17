import { useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { APP_NAME, APP_VERSION_FALLBACK } from "../lib/appinfo";
import { listRecents, removeRecent, type RecentProject } from "../lib/recents";
import { readStored, writeStored } from "../lib/storage";
import { BrandMark } from "./BrandMark";
import { BrandWordmark } from "./BrandWordmark";
import { ClockIcon, FolderIcon, FolderOpenIcon, FolderPickerIcon, PlusIcon, ArrowLeftIcon, SettingsIcon, InfoIcon, TrashIcon } from "./Icons";
import { NewProjectModal } from "./NewProjectModal";
import { UpdateMenu } from "./UpdateMenu";
import { WindowControls } from "./WindowControls";

const RECENTS_WIDTH_KEY = "helmcode.start.recents.width";
const RECENTS_WIDTH_DEFAULT = 260;
const RECENTS_WIDTH_MIN = 220;
const RECENTS_WIDTH_MAX = 420;

const clampRecentsWidth = (value: number) =>
  Number.isFinite(value) ? Math.min(RECENTS_WIDTH_MAX, Math.max(RECENTS_WIDTH_MIN, value)) : RECENTS_WIDTH_DEFAULT;

type Props = {
  currentWorkspace: string;
  hasUnsavedChanges: boolean;
  maximized: boolean;
  autoCheckUpdates: boolean;
  onOpenFolder: () => Promise<void>;
  onOpenRecent: (path: string) => Promise<void>;
  onCreate: (parent: string, name: string) => Promise<void>;
  onSaveAll: () => Promise<boolean>;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
};

export function StartScreen({
  currentWorkspace,
  hasUnsavedChanges,
  maximized,
  autoCheckUpdates,
  onOpenFolder,
  onOpenRecent,
  onCreate,
  onSaveAll,
  onClose,
  onOpenSettings,
  onOpenAbout,
}: Props) {
  const [recents, setRecents] = useState<RecentProject[]>(() => listRecents());
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recentsWidth, setRecentsWidth] = useState(() => clampRecentsWidth(readStored<number>(RECENTS_WIDTH_KEY, RECENTS_WIDTH_DEFAULT)));

  useEffect(() => writeStored(RECENTS_WIDTH_KEY, recentsWidth), [recentsWidth]);

  const beginRecentsResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = recentsWidth;
    const move = (next: MouseEvent) => setRecentsWidth(clampRecentsWidth(startWidth + startX - next.clientX));
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      document.body.classList.remove("resizing");
    };
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  };

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  const drop = (path: string) => {
    removeRecent(path);
    setRecents(listRecents());
  };

  return (
    <div className="start-screen">
      <header className="start-header" data-tauri-drag-region>
        <div className="flex min-w-0 items-center gap-3" data-tauri-drag-region>
          <BrandMark className="h-8 w-8 shrink-0" />
          <BrandWordmark />
          {currentWorkspace && (
            <button
              type="button"
              className="projects-back"
              onClick={onClose}
              title="Torna al progetto aperto"
            >
              <ArrowLeftIcon className="h-4 w-4 shrink-0" />
              <span className="max-w-[220px] truncate">{currentWorkspace.split(/[\\/]/).filter(Boolean).pop()}</span>
            </button>
          )}
        </div>

        <div className="flex flex-1 self-stretch" data-tauri-drag-region />

        <div className="titlebar-actions" data-tauri-drag-region="false">
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

      <div className="start-body" style={{ "--start-recents-width": `${recentsWidth}px` } as CSSProperties}>
        <section className="start-main">
          <div className="start-intro">
            <div className="start-heading">
              <BrandMark className="h-14 w-14 shrink-0" />
              <div>
                <h1>I tuoi progetti</h1>
                <p>Apri una cartella o crea un nuovo spazio di lavoro.</p>
              </div>
            </div>

            <div className="start-actions">
              <button type="button" className="start-action-primary" disabled={busy !== null} onClick={() => void run("folder", onOpenFolder)}>
                <FolderOpenIcon className="h-[18px] w-[18px]" />
                <span>Apri progetto</span>
              </button>
              <button type="button" className="start-action-secondary" disabled={busy !== null} onClick={() => setCreating(true)}>
                <PlusIcon className="h-[18px] w-[18px]" />
                <span>Crea progetto</span>
              </button>
            </div>

            <p className="start-description">
              AGENT e HELM condividono lo stesso workspace: puoi passare dall'assistente all'editor senza perdere file o modifiche.
            </p>
            {hasUnsavedChanges && (
              <p className="mt-3 text-[13px] text-[var(--warning)]">Ci sono modifiche non salvate nel progetto aperto.</p>
            )}
            {error && <p className="modal-error mt-4">{error}</p>}
          </div>

          <footer className="start-footer">
            <span>{APP_NAME} · v{APP_VERSION_FALLBACK}</span>
            <span>AI, codice e Git</span>
          </footer>
        </section>

        <aside className="start-recents" aria-label="Progetti recenti">
          <div className="start-resizer" role="separator" aria-label="Ridimensiona progetti recenti" aria-orientation="vertical" onMouseDown={beginRecentsResize} />
          <div className="recents-heading">
            <h2><ClockIcon className="h-[18px] w-[18px]" /> Progetti recenti</h2>
            {recents.length > 0 && <span className="recents-count">{recents.length}</span>}
          </div>

          <div className="scroll-area min-h-0 flex-1 overflow-y-auto p-2">
            {recents.length === 0 ? (
              <div className="recents-empty">
                <FolderOpenIcon className="mb-4 h-8 w-8 text-[var(--muted)]" />
                <p className="text-[13px] font-medium text-[var(--secondary)]">Nessun progetto recente</p>
                <p className="mt-2 max-w-[180px] text-xs leading-relaxed text-[var(--muted)]">Apri un progetto per ritrovarlo qui al prossimo avvio.</p>
              </div>
            ) : (
              <ul className="flex flex-col gap-1">
                {recents.map((recent) => (
                  <li key={recent.path} className="recent-row group">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-start gap-2.5 text-left disabled:opacity-50"
                      disabled={busy !== null}
                      onClick={() => void run(recent.path, () => onOpenRecent(recent.path))}
                      title={recent.path}
                    >
                      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--overlay)_5%,transparent)] text-[var(--secondary)] group-hover:text-[var(--accent)]">
                        <FolderIcon className="h-[18px] w-[18px]" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-[var(--text)] group-hover:text-[var(--accent)]">{recent.name}</span>
                        <span className="mt-1 block truncate text-xs text-[var(--muted)]">{recent.path}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-button recent-remove shrink-0 text-[var(--muted)] hover:text-[var(--danger)]"
                      title="Rimuovi dai recenti"
                      aria-label={`Rimuovi ${recent.name} dai recenti`}
                      onClick={() => drop(recent.path)}
                    >
                      <TrashIcon className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {busy && (
            <div className="flex items-center gap-2 border-t border-[color-mix(in_srgb,var(--overlay)_10%,transparent)] px-4 py-3 text-xs text-[var(--accent)]">
              <FolderPickerIcon className="h-4 w-4 animate-pulse" /> Apertura…
            </div>
          )}
        </aside>
      </div>

      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreate={async (parent, name) => {
            await onCreate(parent, name);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}
