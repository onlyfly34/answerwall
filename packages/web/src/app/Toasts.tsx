import { For } from 'solid-js';
import type { Component } from 'solid-js';
import { useShell } from './shell-context.ts';

/** The toast stack. A polite live region: screen readers announce each message as it appears. */
export const Toasts: Component = () => {
  const { notify, i18n } = useShell();
  return (
    <div class="app-toasts" role="status" aria-live="polite">
      <For each={notify.toasts()}>
        {(toast) => (
          <div class="app-toast" classList={{ [`is-${toast.kind}`]: true }}>
            <span>{toast.message}</span>
            <button
              type="button"
              class="app-toast-close"
              aria-label={i18n.t('app.toast.dismiss')}
              onClick={() => notify.dismiss(toast.id)}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
};
