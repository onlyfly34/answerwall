import { createUniqueId, For, Match, Show, Switch } from 'solid-js';
import type { Component } from 'solid-js';
import { BRAND } from '@answerwall/core/protocol';
import { saveTextFile } from '../../app/ui/download.ts';
import { useServices } from '../../contracts/services.ts';

export const CA_FILE_NAME = `${BRAND.slug}-ca.crt`;
const PLATFORMS = ['windows', 'macos', 'ios', 'android', 'linux'] as const;

/**
 * How the connection is protected, and for the self-managed certificate
 * authority, its certificate with the steps to trust it on each platform.
 */
export const TlsSection: Component = () => {
  const { settings, i18n } = useServices();
  const t = i18n.t;
  const titleId = createUniqueId();
  const tls = () => settings.server()?.tls;
  const origins = () => settings.server()?.publicOrigins ?? [];

  return (
    <section class="app-card" aria-labelledby={titleId}>
      <h2 id={titleId}>{t('app.settings.tls.title')}</h2>
      <Show when={tls()}>
        {(info) => (
          <>
            <Switch>
              <Match when={info().mode === 'auto'}>
                <p>{t('app.settings.tls.auto')}</p>
              </Match>
              <Match when={info().mode === 'cert'}>
                <p>{t('app.settings.tls.cert')}</p>
              </Match>
              <Match when={info().insecure}>
                <p class="app-error" role="alert">
                  {t('app.settings.tls.insecure')}
                </p>
              </Match>
              <Match when={info().mode === 'off'}>
                <p>{t('app.settings.tls.off')}</p>
              </Match>
            </Switch>

            <Show when={origins().length > 0}>
              <div class="app-field">
                <span class="app-label">{t('app.settings.tls.origins')}</span>
                <ul class="app-list">
                  <For each={origins()}>
                    {(origin) => (
                      <li>
                        <code>{origin}</code>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>

            <Show when={info().caCertificatePem}>
              {(pem) => (
                <>
                  <h3>{t('app.settings.tls.caTitle')}</h3>
                  <p class="app-muted">{t('app.settings.tls.caHelp')}</p>
                  <div class="app-actions">
                    <button
                      type="button"
                      class="app-button is-primary"
                      onClick={() =>
                        saveTextFile(CA_FILE_NAME, pem(), 'application/x-x509-ca-cert')
                      }
                    >
                      {t('app.settings.tls.download', { file: CA_FILE_NAME })}
                    </button>
                  </div>
                  <For each={PLATFORMS}>
                    {(platform) => (
                      <details>
                        <summary>{t(`app.settings.tls.install.${platform}.title`)}</summary>
                        <ol class="app-steps">
                          <For
                            each={t(`app.settings.tls.install.${platform}.steps`, {
                              file: CA_FILE_NAME,
                            }).split('\n')}
                          >
                            {(step) => <li>{step}</li>}
                          </For>
                        </ol>
                      </details>
                    )}
                  </For>
                </>
              )}
            </Show>
          </>
        )}
      </Show>
    </section>
  );
};
