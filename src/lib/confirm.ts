export type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
};

export type PendingConfirm = ConfirmOptions & { resolve: (confirmed: boolean) => void };

/** Kept outside React: one pending confirmation at a time. */
let pending: PendingConfirm | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    pending?.resolve(false);
    pending = { ...options, resolve };
    emit();
  });
}

export function settleConfirm(confirmed: boolean) {
  const current = pending;
  pending = null;
  emit();
  current?.resolve(confirmed);
}

export function subscribeConfirm(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getConfirmSnapshot() {
  return pending;
}
