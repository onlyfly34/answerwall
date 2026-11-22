import type { Component } from 'solid-js';
import { useServices } from '../../contracts/services.ts';

/** Copies `text`; where the clipboard is unavailable (plain HTTP) it says so instead of failing silently. */
export const CopyButton: Component<{ text: string; label: string }> = (props) => {
  const { i18n, notify } = useServices();

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.text);
      notify.toast({ kind: 'success', message: i18n.t('app.copy.done') });
    } catch {
      notify.toast({ kind: 'error', message: i18n.t('app.copy.failed') });
    }
  }

  return (
    <button type="button" class="app-button" aria-label={props.label} onClick={() => void copy()}>
      {i18n.t('app.copy.button')}
    </button>
  );
};
