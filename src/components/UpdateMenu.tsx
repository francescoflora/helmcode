import { useEffect, useState } from "react";
import { getAppVersion } from "../lib/appinfo";
import { canAutoUpdate, useUpdater } from "../lib/updater";
import { AlertIcon, ArrowRightIcon, CheckIcon, DownloadIcon, RefreshIcon, SaveIcon, SparklesIcon, StatusSyncIcon, XIcon } from "./Icons";

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
  const busy = status === "checking" || status === "downloading";

  useEffect(() => {
    void getAppVersion().then(setCurrentVersion);
  }, []);

  const proceed = () => {
    setConfirming(false);
    setOpen(true);
    void install();
  };

  const saveAndProceed = async () => {
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
          title="Controlla aggiornamenti"
          aria-label="Controlla aggiornamenti"
          aria-expanded={open}
        >
          <StatusSyncIcon className={`h-4.5 w-4.5 ${status === "checking" ? "animate-spin text-[var(--accent)]" : ""}`} />
          {available && <span className="pointer-events-none absolute -top-0.5 -right-0.5 h-2 w-2 animate-pulse rounded-full bg-[var(--accent)] ring-2 ring-[var(--chrome)]" />}
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-80 rounded-xl border border-[color-mix(in_srgb,var(--overlay)_10%,transparent)] bg-[var(--color-elevated)] p-3.5 text-left shadow-2xl">
              <div className="mb-3 flex items-center justify-between border-b border-[color-mix(in_srgb,var(--overlay)_10%,transparent)] pb-2">
                <div className="flex items-center gap-2">
                  <StatusSyncIcon className={`h-4 w-4 text-[var(--secondary)] ${status === "checking" ? "animate-spin text-[var(--accent)]" : ""}`} />
                  <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text)]">Aggiornamenti</span>
                </div>
                <span className="rounded-md bg-[color-mix(in_srgb,var(--overlay)_5%,transparent)] px-1.5 py-0.5 font-mono text-[11px] font-medium text-[var(--muted)]">v{currentVersion}</span>
              </div>

              <UpdateBody
                status={status}
                version={version}
                progress={progress}
                error={error}
                supported={supported}
                busy={busy}
                onCheck={() => void check()}
                onInstall={() => setConfirming(true)}
              />
            </div>
          </>
        )}
      </div>

      {confirming && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onClick={() => setConfirming(false)}>
          <div className="w-full max-w-sm rounded-xl border border-[color-mix(in_srgb,var(--overlay)_10%,transparent)] bg-[var(--color-elevated)] p-5 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${hasUnsavedChanges ? "bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning)]" : "bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] text-[var(--accent)]"}`}>
                  {hasUnsavedChanges ? <AlertIcon className="h-5 w-5" /> : <DownloadIcon className="h-5 w-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold text-[var(--text)]">Conferma aggiornamento</h3>
                  <p className="mt-1 text-xs leading-relaxed text-[var(--secondary)]">
                    Proseguendo con l'installazione, helmcode verrà chiuso e riaperto automaticamente per completare l'aggiornamento.
                  </p>
                </div>
              </div>
              <button type="button" className="icon-button" title="Annulla" onClick={() => setConfirming(false)}>
                <XIcon className="h-4 w-4" />
              </button>
            </div>

            {hasUnsavedChanges ? (
              <div className="flex flex-col gap-2">
                <button type="button" className="accent-button flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold disabled:opacity-50" disabled={saving} onClick={() => void saveAndProceed()}>
                  {saving ? <StatusSyncIcon className="h-3.5 w-3.5 animate-spin" /> : <SaveIcon className="h-3.5 w-3.5" />}
                  Salva e procedi
                </button>
                <button type="button" className="ghost-button flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2 text-xs font-medium disabled:opacity-50" disabled={saving} onClick={proceed}>
                  <ArrowRightIcon className="h-3.5 w-3.5" />
                  Procedi senza salvare
                </button>
                <button type="button" className="flex w-full items-center justify-center rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] disabled:opacity-50" disabled={saving} onClick={() => setConfirming(false)}>
                  Annulla
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <button type="button" className="accent-button flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-xs font-semibold" onClick={proceed}>
                  <DownloadIcon className="h-3.5 w-3.5" />
                  Procedi con l'aggiornamento
                </button>
                <button type="button" className="flex w-full items-center justify-center rounded-lg px-3 py-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--text)]" onClick={() => setConfirming(false)}>
                  Annulla
                </button>
              </div>
            )}
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
  supported,
  busy,
  onCheck,
  onInstall,
}: {
  status: ReturnType<typeof useUpdater>["status"];
  version: string | null;
  progress: number | null;
  error: string | null;
  supported: boolean;
  busy: boolean;
  onCheck: () => void;
  onInstall: () => void;
}) {
  if (status === "error") {
    return (
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2 text-xs font-medium text-[var(--danger)]">
          <AlertIcon className="h-4 w-4 shrink-0" /> Verifica aggiornamenti non riuscita.
        </div>
        {error && <p className="truncate rounded border border-[color-mix(in_srgb,var(--overlay)_5%,transparent)] bg-[color-mix(in_srgb,var(--overlay)_5%,transparent)] p-1.5 text-[11px] text-[var(--muted)]" title={error}>{error}</p>}
        {supported && (
          <button type="button" className="ghost-button flex items-center justify-center gap-1.5 self-start rounded-lg px-3 py-1.5 text-xs font-medium" onClick={onCheck}>
            <RefreshIcon className="h-3.5 w-3.5" /> Riprova
          </button>
        )}
      </div>
    );
  }

  if (status === "downloading") {
    return (
      <div className="flex flex-col gap-2.5 py-1">
        <div className="flex items-center justify-between text-xs font-medium text-[var(--text)]">
          <span className="flex items-center gap-2"><RefreshIcon className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" /> Download in corso…</span>
          {progress !== null && <span className="font-mono font-semibold text-[var(--accent)]">{progress}%</span>}
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--overlay)_5%,transparent)] ring-1 ring-[color-mix(in_srgb,var(--overlay)_10%,transparent)]">
          <div className="h-full rounded-full bg-[var(--accent)] transition-all duration-300 ease-out" style={{ width: `${progress ?? 0}%` }} />
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--muted)]">
          helmcode scaricherà la nuova versione e si riavvierà automaticamente.
        </p>
      </div>
    );
  }

  if (status === "ready") {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-emerald-500/25 bg-emerald-500/10 p-3 text-xs font-medium text-emerald-300">
        <CheckIcon className="h-4 w-4 shrink-0" /> Aggiornamento completato. Riavvio in corso…
      </div>
    );
  }

  if (status === "available" && version) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between rounded-lg border border-[var(--accent)]/25 bg-[var(--accent)]/10 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <SparklesIcon className="h-4 w-4 shrink-0 text-[var(--accent)]" />
            <span className="text-xs font-semibold text-[var(--text)]">Disponibile v{version}</span>
          </div>
          <span className="rounded bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--on-accent)]">NEW</span>
        </div>
        <button type="button" className="accent-button flex w-full items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold" onClick={onInstall}>
          <DownloadIcon className="h-4 w-4" /> Scarica e installa
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {status === "none" && (
        <div className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-300">
          <CheckIcon className="h-3.5 w-3.5 shrink-0" /> Nessun aggiornamento disponibile.
        </div>
      )}
      {supported ? (
        <button type="button" className="ghost-button flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-60" disabled={busy} onClick={onCheck}>
          {status === "checking" ? (
            <>
              <RefreshIcon className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
              Verifica in corso…
            </>
          ) : (
            <>
              <RefreshIcon className="h-3.5 w-3.5" />
              Controlla aggiornamenti
            </>
          )}
        </button>
      ) : (
        <p className="text-[11px] leading-relaxed text-[var(--muted)]">
          Gli aggiornamenti automatici sono disponibili solo nella versione installata.
        </p>
      )}
    </div>
  );
}
