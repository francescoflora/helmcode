import { useState } from "react";
import { api, isTauri } from "../lib/tauri";
import { FolderPickerIcon, XIcon } from "./Icons";

type Props = {
  onClose: () => void;
  onCreate: (parent: string, name: string) => Promise<void>;
};

export function NewProjectModal({ onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chooseParent = async () => {
    setError(null);
    try {
      const picked = await api.pickFolder();
      if (picked) setParent(picked);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !parent || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(parent, name.trim());
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal-card" onClick={(event) => event.stopPropagation()} onSubmit={(event) => void submit(event)}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text)]">Nuovo progetto</h2>
            <p className="mt-1 text-[13px] text-[var(--secondary)]">Crea una cartella vuota e aprila come workspace.</p>
          </div>
          <button type="button" className="icon-button" title="Chiudi" aria-label="Chiudi" onClick={onClose}>
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        <label className="field-label" htmlFor="project-name">Nome progetto</label>
        <input
          id="project-name"
          className="field-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="nuovo-progetto"
          autoFocus
          spellCheck={false}
          disabled={busy}
        />

        <label className="field-label mt-4" htmlFor="project-parent">Cartella padre</label>
        <div className="flex items-center gap-2">
          <input
            id="project-parent"
            className="field-input min-w-0"
            value={parent}
            readOnly
            placeholder="Scegli una cartella"
          />
          <button type="button" className="ghost-button flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-[13px]" onClick={() => void chooseParent()} disabled={busy}>
            <FolderPickerIcon className="h-4.5 w-4.5" /> Scegli
          </button>
        </div>

        {!isTauri() && <p className="mt-3 text-xs text-[var(--warning)]">La creazione cartelle è disponibile solo nell'app desktop.</p>}
        {error && <p className="modal-error">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="ghost-button rounded-md px-3.5 py-2 text-[13px]" onClick={onClose} disabled={busy}>Annulla</button>
          <button type="submit" className="accent-button rounded-md px-3.5 py-2 text-[13px] font-semibold disabled:opacity-50" disabled={busy || !name.trim() || !parent}>
            {busy ? "Creazione…" : "Crea e apri"}
          </button>
        </div>
      </form>
    </div>
  );
}
