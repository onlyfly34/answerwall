import { createSignal, ErrorBoundary, onCleanup, onMount, Show } from 'solid-js';
import type { Component, ParentComponent } from 'solid-js';
import { A } from '@solidjs/router';
import { BRAND } from '@answerwall/core/protocol';
import { ROUTES } from '../contracts/routes.ts';
import { useShell } from './shell-context.ts';

/** Whether the browser believes it has a network; drives the offline notice. */
function createOnlineSignal(): () => boolean {
  const [online, setOnline] = createSignal(navigator.onLine);
  onMount(() => {
    const update = (): void => void setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    onCleanup(() => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    });
  });
  return online;
}

const Notices: Component = () => {
  const { shell, settings, i18n } = useShell();
  const online = createOnlineSignal();
  const t = i18n.t;
  return (
    <div class="app-notices">
      <Show when={settings.server()?.tls.insecure}>
        <p class="app-notice is-danger" role="alert">
          {t('app.notice.insecure')}
        </p>
      </Show>
      <Show when={!online()}>
        <p class="app-notice is-warning" role="status">
          {t('app.notice.offline')}
        </p>
      </Show>
      <Show when={shell.updateAvailable()}>
        <p class="app-notice" role="status">
          <span>{t('app.notice.update')}</span>
          <button type="button" class="app-button" onClick={() => void shell.applyUpdate()}>
            {t('app.stale.reload')}
          </button>
        </p>
      </Show>
    </div>
  );
};

/**
 * The frame around every signed-in page: brand, navigation (a top bar that
 * becomes a bottom tab bar on phones), notices, and the page itself.
 */
export const Layout: ParentComponent = (props) => {
  const { meta, i18n } = useShell();
  const t = i18n.t;
  let main!: HTMLElement;

  return (
    <div class="app-shell">
      <button type="button" class="app-skip" onClick={() => main.focus()}>
        {t('app.nav.skip')}
      </button>
      <header class="app-header">
        <span class="app-brand">{meta()?.name ?? BRAND.name}</span>
        <nav class="app-nav" aria-label={t('app.nav.label')}>
          <A href={ROUTES.wall} end activeClass="is-active">
            {t('app.nav.wall')}
          </A>
          <A href={ROUTES.history} activeClass="is-active">
            {t('app.nav.history')}
          </A>
          <A href={ROUTES.providers} activeClass="is-active">
            {t('app.nav.providers')}
          </A>
          <A href={ROUTES.settings} activeClass="is-active">
            {t('app.nav.settings')}
          </A>
        </nav>
      </header>
      <Notices />
      <main ref={main} class="app-main" tabindex="-1">
        <ErrorBoundary
          fallback={(error, reset) => {
            console.error(error);
            return (
              <div class="app-page" role="alert">
                <h1>{t('app.crash.title')}</h1>
                <p>{t('app.crash.body')}</p>
                <div class="app-actions">
                  <button type="button" class="app-button is-primary" onClick={reset}>
                    {t('app.retry')}
                  </button>
                  <button type="button" class="app-button" onClick={() => window.location.reload()}>
                    {t('app.stale.reload')}
                  </button>
                </div>
              </div>
            );
          }}
        >
          {props.children}
        </ErrorBoundary>
      </main>
    </div>
  );
};
