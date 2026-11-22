import { Match, Switch } from 'solid-js';
import type { Component } from 'solid-js';
import { BRAND } from '@answerwall/core/protocol';
import { errorMessage } from '../infra/error-messages.ts';
import { useShell } from './shell-context.ts';

/** The whole page while there is nothing to mount: starting, unreachable, being updated, or failed. */
export const StatusScreen: Component = () => {
  const { shell, meta, i18n } = useShell();
  const t = i18n.t;

  return (
    <main class="app-status">
      <h1>{meta()?.name ?? BRAND.name}</h1>
      <Switch>
        <Match when={shell.phase() === 'loading'}>
          <p role="status">{t('app.loading')}</p>
        </Match>
        <Match when={shell.phase() === 'unreachable'}>
          <p role="alert">{t('app.unreachable')}</p>
          <p class="app-muted">
            {navigator.onLine ? t('app.unreachableHint') : t('app.notice.offline')}
          </p>
          <button type="button" class="app-button is-primary" onClick={() => void shell.start()}>
            {t('app.retry')}
          </button>
        </Match>
        <Match when={shell.phase() === 'stale'}>
          <p role="status">{t('app.stale.title', { version: meta()?.version ?? '' })}</p>
          <p class="app-muted">{t('app.stale.hint')}</p>
          <button
            type="button"
            class="app-button is-primary"
            onClick={() => void shell.applyUpdate()}
          >
            {t('app.stale.reload')}
          </button>
        </Match>
        <Match when={shell.phase() === 'failed'}>
          <p role="alert">{errorMessage(shell.failure(), t)}</p>
          <button type="button" class="app-button is-primary" onClick={() => void shell.start()}>
            {t('app.retry')}
          </button>
        </Match>
      </Switch>
    </main>
  );
};
