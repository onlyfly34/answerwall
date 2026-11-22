import { createSignal, Show } from 'solid-js';
import type { Component } from 'solid-js';
import type { ExtensionTranslate } from './messages.ts';
import { pair, parseServerAddress } from './pairing.ts';
import type { PairingEnvironment, PairingFailure } from './pairing.ts';

export interface SetupProps {
  t: ExtensionTranslate;
  extensionId: string;
  environment: PairingEnvironment;
  /** Shown above the form: why the page is back here. */
  notice?: string | undefined;
  /** The address the page was connected to, as a starting value. */
  initialServer?: string | undefined;
  copy(text: string): Promise<void>;
  /** Paired: the server's origin and the device token it returned. */
  onPaired(origin: string, token: string): void;
}

type Failure = PairingFailure | 'address' | 'fields';

/**
 * The first-run page: where the server is, and the pairing code that makes
 * this extension one of its devices. It also shows the extension's ID, which
 * the server must list before it accepts any request from here.
 */
export const Setup: Component<SetupProps> = (props) => {
  const t = (...args: Parameters<ExtensionTranslate>): string => props.t(...args);
  // A starting value: the field is the user's from then on.
  const [server, setServer] = createSignal(props.initialServer ?? '');
  const [code, setCode] = createSignal('');
  const [deviceName, setDeviceName] = createSignal(t('setup.device.default'));
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<Failure>();
  const [copied, setCopied] = createSignal(false);

  async function submit(): Promise<void> {
    if (busy()) return;
    const address = parseServerAddress(server());
    if (!address) {
      setFailure('address');
      return;
    }
    if (code().trim() === '' || deviceName().trim() === '') {
      setFailure('fields');
      return;
    }
    setFailure(undefined);
    setBusy(true);
    try {
      const result = await pair(props.environment, address, code(), deviceName());
      if (result.ok) props.onPaired(address.origin, result.token);
      else setFailure(result.reason);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main class="app-sign-in ext-setup">
      <h1>{t('setup.title')}</h1>
      <p class="app-muted">{t('setup.intro')}</p>
      <Show when={props.notice}>
        <p class="app-error" role="alert">
          {props.notice}
        </p>
      </Show>

      <section class="app-card" aria-labelledby="setup-allow">
        <h2 id="setup-allow">{t('setup.allow.title')}</h2>
        <p>{t('setup.allow.body')}</p>
        <p class="ext-id">
          <code aria-label={t('setup.allow.id')} data-testid="extension-id">
            {props.extensionId}
          </code>
          <button
            type="button"
            class="app-button"
            onClick={() =>
              void props.copy(props.extensionId).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            {t(copied() ? 'setup.allow.copied' : 'setup.allow.copy')}
          </button>
        </p>
      </section>

      <form
        class="app-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div class="app-field">
          <h2>{t('setup.server.title')}</h2>
          <label for="setup-server">{t('setup.server.label')}</label>
          <input
            id="setup-server"
            class="app-input"
            inputMode="url"
            autocomplete="off"
            spellcheck={false}
            required
            value={server()}
            aria-invalid={failure() === 'address'}
            onInput={(event) => setServer(event.currentTarget.value)}
          />
          <span class="app-muted">{t('setup.server.help')}</span>
        </div>
        <div class="app-field">
          <h2>{t('setup.code.title')}</h2>
          <label for="setup-code">{t('setup.code.label')}</label>
          <input
            id="setup-code"
            class="app-input"
            autocomplete="off"
            required
            value={code()}
            aria-invalid={failure() === 'code'}
            onInput={(event) => setCode(event.currentTarget.value)}
          />
          <span class="app-muted">{t('setup.code.help')}</span>
        </div>
        <div class="app-field">
          <label for="setup-device">{t('setup.device.label')}</label>
          <input
            id="setup-device"
            class="app-input"
            autocomplete="off"
            required
            maxLength={64}
            value={deviceName()}
            onInput={(event) => setDeviceName(event.currentTarget.value)}
          />
          <span class="app-muted">{t('setup.device.help')}</span>
        </div>

        <Show when={failure()}>
          {(reason) => (
            <p class="app-error" role="alert">
              {t(`setup.error.${reason()}`)}
            </p>
          )}
        </Show>
        <button type="submit" class="app-button is-primary" disabled={busy()}>
          {t(busy() ? 'setup.submitting' : 'setup.submit')}
        </button>
      </form>
      <p class="app-muted">{t('setup.terms')}</p>
    </main>
  );
};
