import { useEffect } from "react";
import { XIcon } from "./Icons";

type Props = {
  warning: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export function CloseConfirmModal({ warning, onConfirm, onCancel }: Props) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal-card max-w-md" role="dialog" aria-modal="true" aria-labelledby="close-confirm-title" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="close-confirm-title" className="text-lg font-semibold text-[var(--text)]">Sei proprio sicuro di voler chiudere la finestra?</h2>
            {warning && <p className="mt-2 text-[13px] leading-relaxed text-[var(--warning)]">{warning}</p>}
          </div>
          <button type="button" className="icon-button" title="Chiudi" aria-label="Chiudi" onClick={onCancel}>
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="ghost-button rounded-md px-3.5 py-2 text-[13px]" onClick={onCancel} autoFocus>No</button>
          <button type="button" className="accent-button rounded-md px-3.5 py-2 text-[13px] font-semibold" onClick={onConfirm}>Sì, chiudi</button>
        </div>
      </div>
    </div>
  );
}
