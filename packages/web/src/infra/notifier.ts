import { createSignal } from 'solid-js';
import type { Accessor } from 'solid-js';
import { ApiError } from '../contracts/services.ts';
import type { Notifier, Toast, Translate } from '../contracts/services.ts';
import { errorMessage } from './error-messages.ts';

export interface ToastItem extends Toast {
  id: number;
}

export interface ToastCenter extends Notifier {
  toasts: Accessor<ToastItem[]>;
  dismiss(id: number): void;
}

export interface NotifierDeps {
  t: Translate;
  /** A request was rejected with 401: the session is gone. */
  onUnauthorized(): void;
}

export const MAX_TOASTS = 4;
/** Errors stay longer: they usually need reading twice. */
export const TOAST_DURATION_MS: Record<Toast['kind'], number> = {
  info: 4_000,
  success: 4_000,
  error: 8_000,
};

export function createNotifier(deps: NotifierDeps): ToastCenter {
  const [toasts, setToasts] = createSignal<ToastItem[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;

  function dismiss(id: number): void {
    clearTimeout(timers.get(id));
    timers.delete(id);
    setToasts((list) => list.filter((item) => item.id !== id));
  }

  function expireLater(id: number, kind: Toast['kind']): void {
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => dismiss(id), TOAST_DURATION_MS[kind]),
    );
  }

  function toast({ kind, message }: Toast): void {
    // The same message again (a retry failing the same way) restarts its timer.
    const shown = toasts().find((item) => item.kind === kind && item.message === message);
    if (shown) {
      expireLater(shown.id, kind);
      return;
    }
    const item: ToastItem = { id: nextId++, kind, message };
    for (const dropped of toasts().slice(0, -(MAX_TOASTS - 1))) dismiss(dropped.id);
    setToasts((list) => [...list, item]);
    expireLater(item.id, kind);
  }

  return {
    toasts,
    dismiss,
    toast,
    reportError(error) {
      if (error instanceof ApiError && error.status === 401) {
        deps.onUnauthorized();
        return;
      }
      // Anything that is not an API failure is a defect worth a trace.
      if (!(error instanceof ApiError)) console.error(error);
      toast({ kind: 'error', message: errorMessage(error, deps.t) });
    },
  };
}
