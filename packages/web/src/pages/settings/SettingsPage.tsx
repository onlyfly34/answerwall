import { createSignal, createUniqueId, Show } from 'solid-js';
import type { Component } from 'solid-js';
import { A } from '@solidjs/router';
import type { SettingsPatch } from '@answerwall/core/protocol';
import { ROUTES } from '../../contracts/routes.ts';
import { useServices } from '../../contracts/services.ts';
import { BUILD_VERSION } from '../../infra/build-info.ts';
import { DevicesSection } from './DevicesSection.tsx';
import type { DevicesSectionProps } from './DevicesSection.tsx';
import { GeneralSection } from './GeneralSection.tsx';
import { LimitsSection } from './LimitsSection.tsx';
import { TlsSection } from './TlsSection.tsx';
import { WebCellsSection } from './WebCellsSection.tsx';

/** Everything configurable that is not a provider, plus the devices and the connection's security. */
export const SettingsPage: Component<DevicesSectionProps> = (props) => {
  const { settings, meta, notify, i18n } = useServices();
  const t = i18n.t;
  const aboutId = createUniqueId();
  /** Bumped by a refused save: controls that save on change are rebuilt from the stored values. */
  const [generation, setGeneration] = createSignal(1);

  async function save(patch: SettingsPatch): Promise<boolean> {
    try {
      await settings.update(patch);
      return true;
    } catch (error) {
      notify.reportError(error);
      setGeneration((current) => current + 1);
      return false;
    }
  }

  /**
   * For a section whose every control saves at once and whose patches carry
   * a whole list (the providers, the extension IDs): one save at a time, and
   * each patch is built only when its turn has come, from the settings as
   * the save before it left them. Two quick changes would otherwise both be
   * built from the same list, and the second would undo the first.
   */
  let turn: Promise<unknown> = Promise.resolve();
  function saveInTurn(build: () => SettingsPatch | undefined): Promise<boolean> {
    const next = turn.then(() => {
      const patch = build();
      return patch === undefined ? true : save(patch);
    });
    turn = next.catch(() => undefined);
    return next;
  }

  return (
    <div class="app-page">
      <h1>{t('app.settings.title')}</h1>
      <p class="app-muted">
        {t('app.settings.providersHint')} <A href={ROUTES.providers}>{t('app.nav.providers')}</A>
      </p>
      <Show when={generation()} keyed>
        {(_generation) => <GeneralSection save={save} />}
      </Show>
      <LimitsSection save={save} />
      {/* The desktop app signs in with a token per launch; it has no paired devices. */}
      <Show when={meta()?.mode !== 'desktop'}>
        <DevicesSection onLogout={() => props.onLogout()} onSignedOut={() => props.onSignedOut()} />
      </Show>
      {/* Web cells need a browser extension paired as a device, which the desktop app does not have. */}
      <Show when={meta()?.mode !== 'desktop'}>
        <Show when={generation()} keyed>
          {(_generation) => <WebCellsSection save={saveInTurn} />}
        </Show>
      </Show>
      <TlsSection />
      <section class="app-card" aria-labelledby={aboutId}>
        <h2 id={aboutId}>{t('app.settings.about.title')}</h2>
        <dl class="app-facts">
          <dt>{t('app.settings.about.version')}</dt>
          <dd>{meta()?.version ?? BUILD_VERSION}</dd>
          <dt>{t('app.settings.about.mode')}</dt>
          <dd>
            {meta()?.mode === 'desktop'
              ? t('app.settings.about.desktop')
              : t('app.settings.about.server')}
          </dd>
        </dl>
      </section>
    </div>
  );
};
