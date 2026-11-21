import { useEffect, useSyncExternalStore } from "react";
import { getConfirmSnapshot, settleConfirm, subscribeConfirm } from "../lib/confirm";
import { AlertIcon, XIcon } from "./Icons";

export function ConfirmHost() {
  const current = useSyncExternalStore(subscribeConfirm, getConfirmSnapshot);

  useEffect(() => {
    if (!current) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      settleConfirm(false);
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [current]);

  if (!current) return null;

  return (
    <div className="modal-backdrop" onClick={() => settleConfirm(false)}>
      <div className="modal-card max-w-md" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            {current.danger && (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--danger)_15%,transparent)] text-[var(--danger)]">
                <AlertIcon className="h-5 w-5" />
              </div>
            )}
            <div className="min-w-0">
              <h2 id="confirm-title" className="text-lg font-semibold text-[var(--text)]">{current.title}</h2>
              <p className="mt-1 whitespace-pre-line text-[13px] leading-relaxed text-[var(--secondary)]">{current.message}</p>
            </div>
          </div>
          <button type="button" className="icon-button" title="Chiudi" aria-label="Chiudi" onClick={() => settleConfirm(false)}>
            <XIcon className="h-4.5 w-4.5" />
          </button>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="ghost-button rounded-md px-3.5 py-2 text-[13px]" onClick={() => settleConfirm(false)} autoFocus>{current.cancelLabel ?? "Annulla"}</button>
          <button type="button" className={`${current.danger ? "danger-button" : "accent-button"} rounded-md px-3.5 py-2 text-[13px] font-semibold`} onClick={() => settleConfirm(true)}>{current.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
