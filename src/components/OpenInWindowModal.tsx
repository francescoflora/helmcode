import { useState } from "react";
import { FolderOpenIcon, WindowIcon, XIcon } from "./Icons";

type Props = {
  name: string;
  path?: string;
  creating: boolean;
  onChoose: (target: "current" | "new") => Promise<void>;
  onClose: () => void;
};

export function OpenInWindowModal({ name, path, creating, onChoose, onClose }: Props) {
  const [busy, setBusy] = useState<"current" | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (target: "current" | "new") => {
    if (busy) return;
    setBusy(target);
    setError(null);
    try {
      await onChoose(target);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal-card max-w-sm" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)]">{creating ? "Crea e apri il progetto" : "Apri il progetto"}</h2>
            <p className="mt-1 text-[13px] text-[var(--secondary)]">Scegli dove aprire {name}.</p>
          </div>
          <button type="button" className="icon-button" title="Chiudi" aria-label="Chiudi" onClick={onClose} disabled={Boolean(busy)}>
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        <p className="truncate font-mono text-xs text-[var(--muted)]" title={path ?? name}>{path ?? name}</p>

        <div className="window-choice">
          <button type="button" className="window-choice-option" disabled={Boolean(busy)} onClick={() => void choose("current")}>
            <FolderOpenIcon className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-[var(--text)]">Questa finestra</span>
              <span className="block text-xs text-[var(--muted)]">{busy === "current" ? "Apertura…" : "Sostituisce il progetto aperto qui"}</span>
            </span>
          </button>
          <button type="button" className="window-choice-option" disabled={Boolean(busy)} onClick={() => void choose("new")}>
            <WindowIcon className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-[var(--text)]">Nuova finestra</span>
              <span className="block text-xs text-[var(--muted)]">{busy === "new" ? "Apertura…" : "Mantiene questo progetto aperto"}</span>
            </span>
          </button>
        </div>

        {error && <p className="modal-error mt-3">{error}</p>}

        <div className="mt-5 flex justify-end">
          <button type="button" className="ghost-button rounded-md px-3.5 py-2 text-[13px]" onClick={onClose} disabled={Boolean(busy)}>Annulla</button>
        </div>
      </div>
    </div>
  );
}
