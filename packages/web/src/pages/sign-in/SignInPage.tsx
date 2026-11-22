import { createSignal, createUniqueId, For, Match, Show, Switch } from 'solid-js';
import type { Component } from 'solid-js';
import {
  BRAND,
  LANGUAGES,
  PAIRING_CODE_DIGITS,
  PairRequestSchema,
  SessionRequestSchema,
} from '@answerwall/core/protocol';
import type { Language, PairRequest, SessionRequest } from '@answerwall/core/protocol';
import type { MessageKey } from '../../contracts/messages.ts';
import { ApiError, useServices } from '../../contracts/services.ts';
import { errorMessage } from '../../infra/error-messages.ts';
import { LANGUAGE_NAMES } from '../language-names.ts';
import { suggestDeviceName } from './device-name.ts';

type Method = 'code' | 'token';
type FieldName = 'code' | 'deviceName' | 'token';
type Attempt =
  { method: 'code'; request: PairRequest } | { method: 'token'; request: SessionRequest };

const FIELD_ERRORS: Record<FieldName, MessageKey> = {
  code: 'app.signIn.codeFormat',
  deviceName: 'app.signIn.deviceNameFormat',
  token: 'app.signIn.tokenFormat',
};

/** Sign-in failures that deserve their own explanation; anything else gets the general one. */
function failureKey(error: unknown, method: Method): MessageKey | undefined {
  if (!(error instanceof ApiError)) return undefined;
  switch (error.code) {
    case 'invalid_code':
      return 'app.signIn.error.invalidCode';
    case 'unauthorized':
      return method === 'token' ? 'app.signIn.error.invalidToken' : 'app.signIn.error.invalidCode';
    case 'rate_limited':
      return 'app.signIn.error.rateLimited';
    case 'device_limit':
      return 'app.signIn.error.deviceLimit';
    default:
      return undefined;
  }
}

export interface SignInPageProps {
  /** The session cookie is set: the shell loads the app. */
  onSignedIn(): void | Promise<void>;
}

/** Pairs this device with a pairing code, or signs in with an access token. */
export const SignInPage: Component<SignInPageProps> = (props) => {
  const { api, i18n, meta } = useServices();
  const t = i18n.t;
  const ids = { code: createUniqueId(), deviceName: createUniqueId(), token: createUniqueId() };

  const [method, setMethod] = createSignal<Method>('code');
  const [code, setCode] = createSignal('');
  const [deviceName, setDeviceName] = createSignal(suggestDeviceName(navigator.userAgent));
  const [token, setToken] = createSignal('');
  const [invalid, setInvalid] = createSignal<FieldName>();
  const [failure, setFailure] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);

  /** Validates the form and returns the request to send, or flags the first bad field. */
  function buildAttempt(): Attempt | undefined {
    if (method() === 'token') {
      const session = SessionRequestSchema.safeParse({ token: token().trim() });
      if (session.success) return { method: 'token', request: session.data };
      setInvalid('token');
      return undefined;
    }
    // Codes are often read out or pasted in groups: "1234 5678", "1234-5678".
    const pairing = PairRequestSchema.safeParse({
      code: code().replace(/[\s-]/g, ''),
      deviceName: deviceName(),
    });
    if (pairing.success) return { method: 'code', request: pairing.data };
    setInvalid(pairing.error.issues[0]?.path[0] === 'deviceName' ? 'deviceName' : 'code');
    return undefined;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy()) return;
    setInvalid(undefined);
    setFailure(undefined);
    const attempt = buildAttempt();
    if (!attempt) {
      const field = invalid();
      if (field) document.getElementById(ids[field])?.focus();
      return;
    }
    setBusy(true);
    try {
      if (attempt.method === 'token') await api.signIn(attempt.request);
      else await api.pair(attempt.request);
      await props.onSignedIn();
    } catch (error) {
      const key = failureKey(error, attempt.method);
      setFailure(key ? t(key) : errorMessage(error, t));
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (field: FieldName) => (
    <Show when={invalid() === field}>
      <span id={`${ids[field]}-error`} class="app-error">
        {t(FIELD_ERRORS[field], { digits: PAIRING_CODE_DIGITS })}
      </span>
    </Show>
  );
  const describedBy = (field: FieldName) =>
    invalid() === field ? `${ids[field]}-error` : undefined;

  return (
    <main class="app-sign-in">
      <h1>{meta()?.name ?? BRAND.name}</h1>
      <p>{t('app.signIn.intro')}</p>
      <form class="app-form" noValidate onSubmit={(event) => void submit(event)}>
        <fieldset class="app-field">
          <legend>{t('app.signIn.method')}</legend>
          <label class="app-check">
            <input
              type="radio"
              name="method"
              checked={method() === 'code'}
              onChange={() => setMethod('code')}
            />
            {t('app.signIn.methodCode')}
          </label>
          <label class="app-check">
            <input
              type="radio"
              name="method"
              checked={method() === 'token'}
              onChange={() => setMethod('token')}
            />
            {t('app.signIn.methodToken')}
          </label>
        </fieldset>

        <Switch>
          <Match when={method() === 'code'}>
            <div class="app-field">
              <label for={ids.code}>{t('app.signIn.code')}</label>
              <input
                id={ids.code}
                class="app-input"
                inputMode="numeric"
                autocomplete="one-time-code"
                required
                value={code()}
                aria-invalid={invalid() === 'code'}
                aria-describedby={describedBy('code')}
                onInput={(event) => setCode(event.currentTarget.value)}
              />
              {fieldError('code')}
              <span class="app-muted">
                {t('app.signIn.codeHelp', { command: `${BRAND.cliName} pair` })}
              </span>
            </div>
            <div class="app-field">
              <label for={ids.deviceName}>{t('app.signIn.deviceName')}</label>
              <input
                id={ids.deviceName}
                class="app-input"
                autocomplete="off"
                required
                maxLength={64}
                value={deviceName()}
                aria-invalid={invalid() === 'deviceName'}
                aria-describedby={describedBy('deviceName')}
                onInput={(event) => setDeviceName(event.currentTarget.value)}
              />
              {fieldError('deviceName')}
              <span class="app-muted">{t('app.signIn.deviceNameHelp')}</span>
            </div>
          </Match>
          <Match when={method() === 'token'}>
            <div class="app-field">
              <label for={ids.token}>{t('app.signIn.token')}</label>
              <input
                id={ids.token}
                class="app-input"
                type="password"
                autocomplete="off"
                required
                value={token()}
                aria-invalid={invalid() === 'token'}
                aria-describedby={describedBy('token')}
                onInput={(event) => setToken(event.currentTarget.value)}
              />
              {fieldError('token')}
              <span class="app-muted">{t('app.signIn.tokenHelp')}</span>
            </div>
          </Match>
        </Switch>

        <Show when={failure()}>
          <p class="app-error" role="alert">
            {failure()}
          </p>
        </Show>

        <button type="submit" class="app-button is-primary" disabled={busy()}>
          {busy() ? t('app.signIn.submitting') : t('app.signIn.submit')}
        </button>
      </form>

      <div class="app-field">
        <label for={`${ids.code}-language`}>{t('app.settings.language.label')}</label>
        <select
          id={`${ids.code}-language`}
          class="app-input"
          onChange={(event) => i18n.setLanguage(event.currentTarget.value as Language)}
        >
          <For each={LANGUAGES}>
            {(language) => (
              <option value={language} selected={i18n.language() === language}>
                {LANGUAGE_NAMES[language]}
              </option>
            )}
          </For>
        </select>
      </div>
    </main>
  );
};
