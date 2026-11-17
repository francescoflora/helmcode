import { useEffect, useState } from "react";
import { getAppVersion, RELEASES_URL } from "../lib/appinfo";
import { openExternalUrl } from "../lib/opener";
import { canAutoUpdate, useUpdater } from "../lib/updater";
import { AlertIcon, CheckIcon, DownloadIcon, RefreshIcon, StatusSyncIcon, XIcon } from "./Icons";

type Props = {
  autoCheck: boolean;
  hasUnsavedChanges: boolean;
  onSaveAll: () => Promise<boolean>;
};

export function UpdateMenu({ autoCheck, hasUnsavedChanges, onSaveAll }: Props) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [currentVersion, setCurrentVersion] = useState("…");
  const { status, version, progress, error, check, install } = useUpdater(autoCheck);
  const supported = canAutoUpdate();
  const available = status === "available";

  useEffect(() => {
    void getAppVersion().then(setCurrentVersion);
  }, []);

  const startInstall = () => {
    setConfirming(true);
  };

  const proceed = () => {
    setConfirming(false);
    setOpen(true);
    void install();
  };

  const saveAndInstall = async () => {
    setSaving(true);
    try {
      await onSaveAll();
    } catch {
      /* il salvataggio segnala l'errore altrove: l'aggiornamento prosegue comunque */
    } finally {
      setSaving(false);
      proceed();
    }
  };

  return (
    <>
      <div className="toolbar-menu relative flex self-stretch items-stretch">
        <button
          type="button"
          className={`toolbar-icon-button ${open || available ? "is-active" : ""}`}
          onClick={() => setOpen((value) => !value)}
          title="Aggiornamenti"
          aria-label="Aggiornamenti"
        >
          <StatusSyncIcon className={`h-4.5 w-4.5 ${status === "checking" ? "animate-spin text-[var(--accent)]" : ""}`} />
          {available && <span className="absolute right-1.5 top-2.5 h-1.5 w-1.5 rounded-full bg-[var(--accent)] ring-2 ring-[var(--color-surface)]" />}
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-80 rounded-xl border border-[color-mix(in_srgb,var(--overlay)_10%,transparent)] bg-[var(--color-elevated)] p-3.5 text-left shadow-2xl">
              <div className="mb-3 flex items-center justify-between border-b border-[color-mix(in_srgb,var(--overlay)_10%,transparent)] pb-2">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text)]">
                  <StatusSyncIcon className={`h-4.5 w-4.5 ${status === "checking" ? "animate-spin text-[var(--accent)]" : ""}`} />
                  Aggiornamenti
                </div>
                <span className="rounded bg-[color-mix(in_srgb,var(--overlay)_5%,transparent)] px-1.5 py-0.5 font-mono text-xs text-[var(--secondary)]">v{currentVersion}</span>
              </div>

              {!supported ? (
                <div className="flex flex-col gap-2.5">
                  <p className="text-xs leading-relaxed text-[var(--secondary)]">
                    Gli aggiornamenti automatici non sono ancora disponibili. Scarica l'ultima versione da GitHub.
                  </p>
                  <button type="button" className="ghost-button flex items-center justify-center gap-2 rounded-md px-3 py-2 text-[13px]" onClick={() => void openExternalUrl(RELEASES_URL)}>
                    <DownloadIcon className="h-4.5 w-4.5" /> Apri release GitHub
                  </button>
                </div>
              ) : (
                <UpdateBody
                  status={status}
                  version={version}
                  progress={progress}
                  error={error}
                  onCheck={() => void check()}
                  onInstall={startInstall}
                  onRetry={() => void check()}
                />
              )}
            </div>
          </>
        )}
      </div>

      {confirming && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onClick={() => setConfirming(false)}>
          <div className="w-full max-w-sm rounded-xl border border-[color-mix(in_srgb,var(--overlay)_10%,transparent)] bg-[var(--color-elevated)] p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-[var(--text)]">Aggiorna helmcode</h3>
                <p className="mt-1 text-[13px] leading-relaxed text-[var(--secondary)]">
                  {hasUnsavedChanges
                    ? "Ci sono modifiche non salvate. Salvale prima di installare l'aggiornamento."
                    : "helmcode verrà chiuso e riavviato per completare l'aggiornamento."}
                </p>
              </div>
              <button type="button" className="icon-button" title="Annulla" onClick={() => setConfirming(false)}>
                <XIcon className="h-4.5 w-4.5" />
              </button>
            </div>
            <div className="mt-4 flex flex-col gap-2">
              {hasUnsavedChanges ? (
                <>
                  <button type="button" className="accent-button rounded-lg px-3 py-2 text-[13px] font-semibold disabled:opacity-50" disabled={saving} onClick={() => void saveAndInstall()}>
                    {saving ? "Salvataggio…" : "Salva e aggiorna"}
                  </button>
                  <button type="button" className="ghost-button rounded-lg px-3 py-2 text-[13px]" disabled={saving} onClick={proceed}>
                    Procedi senza salvare
                  </button>
                </>
              ) : (
                <button type="button" className="accent-button rounded-lg px-3 py-2 text-[13px] font-semibold" onClick={proceed}>
                  Scarica e installa
                </button>
              )}
              <button type="button" className="ghost-button rounded-lg px-3 py-2 text-[13px]" disabled={saving} onClick={() => setConfirming(false)}>
                Annulla
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function UpdateBody({
  status,
  version,
  progress,
  error,
  onCheck,
  onInstall,
  onRetry,
}: {
  status: ReturnType<typeof useUpdater>["status"];
  version: string | null;
  progress: number | null;
  error: string | null;
  onCheck: () => void;
  onInstall: () => void;
  onRetry: () => void;
}) {
  if (status === "error") {
    return (
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--danger)]">
          <AlertIcon className="h-4.5 w-4.5" /> Controllo non riuscito
        </div>
        {error && <p className="truncate rounded border border-[color-mix(in_srgb,var(--overlay)_5%,transparent)] bg-[color-mix(in_srgb,var(--overlay)_5%,transparent)] p-1.5 text-xs text-[var(--secondary)]" title={error}>{error}</p>}
        <button type="button" className="ghost-button flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[13px]" onClick={onRetry}>
          <RefreshIcon className="h-4.5 w-4.5" /> Riprova
        </button>
      </div>
    );
  }

  if (status === "downloading") {
    return (
      <div className="flex flex-col gap-2.5 py-1">
        <div className="flex items-center justify-between text-[13px] font-medium text-[var(--text)]">
          <span className="flex items-center gap-2"><RefreshIcon className="h-4.5 w-4.5 animate-spin text-[var(--accent)]" /> Download in corso</span>
          {progress !== null && <span className="font-mono font-semibold text-[var(--accent)]">{progress}%</span>}
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--overlay)_5%,transparent)] ring-1 ring-white/10">
          <div className="h-full rounded-full bg-[var(--accent)] transition-all duration-300" style={{ width: `${progress ?? 0}%` }} />
        </div>
      </div>
    );
  }

  if (status === "ready") {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3 text-[13px] font-medium text-emerald-300">
        <CheckIcon className="h-4.5 w-4.5" /> Aggiornamento installato. Riavvio…
      </div>
    );
  }

  if (status === "available" && version) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between rounded-lg border border-[var(--accent)]/25 bg-[var(--accent)]/10 px-3 py-2.5">
          <span className="text-[13px] font-semibold text-[var(--text)]">Disponibile v{version}</span>
          <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--on-accent)]">Nuova</span>
        </div>
        <button type="button" className="accent-button flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-semibold" onClick={onInstall}>
          <DownloadIcon className="h-4.5 w-4.5" /> Scarica e installa
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {status === "none" && (
        <div className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-[13px] text-emerald-300">
          <CheckIcon className="h-4.5 w-4.5" /> Sei aggiornato
        </div>
      )}
      <button type="button" className="ghost-button flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] disabled:opacity-60" disabled={status === "checking"} onClick={onCheck}>
        <RefreshIcon className={`h-4.5 w-4.5 ${status === "checking" ? "animate-spin text-[var(--accent)]" : ""}`} />
        {status === "checking" ? "Controllo…" : "Controlla aggiornamenti"}
      </button>
    </div>
  );
}
