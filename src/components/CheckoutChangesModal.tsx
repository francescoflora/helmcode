import { useEffect } from "react";
import { ArrowLeftIcon, GitBranchIcon, XIcon } from "./Icons";

type Props = {
  from: string;
  to: string;
  onChoose: (carryChanges: boolean) => void;
  onClose: () => void;
};

export function CheckoutChangesModal({ from, to, onChoose, onClose }: Props) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card max-w-md" role="dialog" aria-modal="true" aria-labelledby="checkout-changes-title" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="checkout-changes-title" className="flex items-center gap-2 text-lg font-semibold text-[var(--text)]">
              <GitBranchIcon className="h-5 w-5 text-[var(--accent)]" /> Modifiche non committate
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--secondary)]">
              Git non può passare da {from} a {to} senza sovrascrivere le modifiche locali. Come vuoi procedere?
            </p>
          </div>
          <button type="button" className="icon-button" title="Chiudi" aria-label="Chiudi" onClick={onClose}>
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        <div className="window-choice">
          <button type="button" className="window-choice-option" onClick={() => onChoose(true)} autoFocus>
            <GitBranchIcon className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-[var(--text)]">Porta le modifiche</span>
              <span className="block text-xs text-[var(--muted)]">Le modifiche restano nel nuovo branch. Nessun commit o push.</span>
            </span>
          </button>
          <button type="button" className="window-choice-option" onClick={() => onChoose(false)}>
            <ArrowLeftIcon className="h-5 w-5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-[var(--text)]">Lascia nello stash</span>
              <span className="block text-xs text-[var(--muted)]">Il nuovo branch parte pulito. Le modifiche restano recuperabili nello stash.</span>
            </span>
          </button>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="ghost-button rounded-md px-3.5 py-2 text-[13px]" onClick={onClose}>Annulla</button>
        </div>
      </div>
    </div>
  );
}
