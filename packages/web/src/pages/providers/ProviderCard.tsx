import { createSignal, createUniqueId, Show } from 'solid-js';
import type { Component } from 'solid-js';
import {
  concurrencyBounds,
  isCliKind,
  KINDS_REQUIRING_ACKNOWLEDGEMENT,
} from '@answerwall/core/protocol';
import type {
  ProviderInstance,
  ProviderInstanceInput,
  ProviderStatus,
  WebProviderInstance,
} from '@answerwall/core/protocol';
import { CopyButton } from '../../app/ui/CopyButton.tsx';
import { formatDateTime } from '../../app/ui/format.ts';
import type { MessageKey } from '../../contracts/messages.ts';
import { useServices } from '../../contracts/services.ts';
import { desktopBridge } from '../../infra/desktop-bridge.ts';
import { AcknowledgeDialog } from './AcknowledgeDialog.tsx';
import { ModelsEditor } from './ModelsEditor.tsx';
import { toInput } from './provider-edits.ts';

const LOGIN_KEYS: Record<'yes' | 'no' | 'unknown', MessageKey> = {
  yes: 'app.providers.login.yes',
  no: 'app.providers.login.no',
  unknown: 'app.providers.login.unknown',
};
const BILLING_KEYS: Record<'subscription' | 'api-key' | 'unknown', MessageKey> = {
  subscription: 'app.providers.billing.subscription',
  'api-key': 'app.providers.billing.apiKey',
  unknown: 'app.providers.billing.unknown',
};
const STREAMING_KEYS: Record<'token' | 'block' | 'unknown', MessageKey> = {
  token: 'app.providers.streaming.token',
  block: 'app.providers.streaming.block',
  unknown: 'app.providers.streaming.unknown',
};
const TOOL_KEYS: Record<ProviderStatus['toolAccess'], MessageKey> = {
  none: 'app.providers.tools.none',
  disabled: 'app.providers.tools.disabled',
  'read-only': 'app.providers.tools.readOnly',
  unrestricted: 'app.providers.tools.unrestricted',
};

/** A click only asks for the change: the box keeps showing the saved value until the save lands. */
function requestToggle(box: HTMLInputElement, saved: boolean, apply: (wanted: boolean) => void) {
  const wanted = box.checked;
  box.checked = saved;
  apply(wanted);
}

export interface ProviderCardProps {
  /** A CLI or an endpoint; web providers are configured in the settings. */
  instance: Exclude<ProviderInstance, WebProviderInstance>;
  /** Missing until the server has listed this provider. */
  status: ProviderStatus | undefined;
  /** A save or a refresh is running. */
  disabled: boolean;
  /** Saves the changed instance; resolves whether it was accepted. */
  onChange(next: ProviderInstanceInput): Promise<boolean>;
  onRefresh(): void;
  /** Endpoints only. */
  onEdit?: () => void;
  onRemove?: () => void;
}

/** One provider: what the server detected, how to sign in, and its settings. */
export const ProviderCard: Component<ProviderCardProps> = (props) => {
  const { i18n, meta, notify } = useServices();
  const t = i18n.t;
  const ids = {
    enabled: createUniqueId(),
    concurrency: createUniqueId(),
    envKey: createUniqueId(),
    webSearch: createUniqueId(),
  };
  const [acknowledging, setAcknowledging] = createSignal(false);
  const [concurrencyInvalid, setConcurrencyInvalid] = createSignal(false);

  const input = (): ProviderInstanceInput => toInput(props.instance);
  const bounds = () => concurrencyBounds(props.instance.kind);
  const detection = () => props.status?.detection ?? undefined;
  const isCli = () => isCliKind(props.instance.kind);

  // Only the desktop app's local window has the bridge; a browser never does.
  const bridge = () => (meta()?.mode === 'desktop' ? desktopBridge() : undefined);
  const [openingTerminal, setOpeningTerminal] = createSignal(false);

  async function openLoginTerminal(): Promise<void> {
    const kind = props.instance.kind;
    const shell = bridge();
    if (!shell || !isCliKind(kind) || openingTerminal()) return;
    setOpeningTerminal(true);
    try {
      const opened = await shell.openLoginTerminal(kind);
      if (opened.ok) {
        notify.toast({ kind: 'info', message: t('app.providers.loginTerminal.opened') });
      } else if (opened.reason === 'busy') {
        notify.toast({ kind: 'info', message: t('app.providers.loginTerminal.busy') });
      } else {
        notify.toast({ kind: 'error', message: t('app.providers.loginTerminal.failed') });
      }
    } catch {
      notify.toast({ kind: 'error', message: t('app.providers.loginTerminal.failed') });
    } finally {
      setOpeningTerminal(false);
    }
  }

  function toggle(enabled: boolean): void {
    const instance = props.instance;
    const needsNotice =
      enabled &&
      instance.kind !== 'openai-compat' &&
      KINDS_REQUIRING_ACKNOWLEDGEMENT.includes(instance.kind) &&
      !instance.riskAcknowledged;
    if (needsNotice) setAcknowledging(true);
    else void props.onChange({ ...input(), enabled });
  }

  function acknowledge(): void {
    setAcknowledging(false);
    const instance = props.instance;
    if (instance.kind === 'openai-compat') return;
    void props.onChange({ ...instance, enabled: true, riskAcknowledged: true });
  }

  function changeConcurrency(text: string): void {
    const value = Number(text);
    const valid = Number.isInteger(value) && value >= bounds().min && value <= bounds().max;
    setConcurrencyInvalid(!valid);
    if (valid && value !== props.instance.concurrency) {
      void props.onChange({ ...input(), concurrency: value });
    }
  }

  return (
    <section class="app-card" aria-label={props.instance.label}>
      <div class="app-card-header">
        <h3>
          {props.instance.label}{' '}
          <span class="app-badge">{t(`app.providers.kind.${props.instance.kind}`)}</span>
        </h3>
        <div class="app-check">
          <input
            id={ids.enabled}
            type="checkbox"
            checked={props.instance.enabled}
            disabled={props.disabled}
            onChange={(event) => requestToggle(event.currentTarget, props.instance.enabled, toggle)}
          />
          <label for={ids.enabled}>{t('app.providers.enabled')}</label>
        </div>
      </div>

      <Show when={props.instance.kind === 'openai-compat' && props.instance}>
        {(endpoint) => (
          <dl class="app-facts">
            <dt>{t('app.providers.endpoint.baseUrl')}</dt>
            <dd>{endpoint().baseUrl}</dd>
            <dt>{t('app.providers.endpoint.apiKey')}</dt>
            <dd>
              {endpoint().hasApiKey
                ? t('app.providers.endpoint.keyStored')
                : t('app.providers.endpoint.keyMissing')}
            </dd>
          </dl>
        )}
      </Show>

      <Show
        when={detection()}
        fallback={
          <p class="app-muted">
            {props.status?.detecting
              ? t('app.providers.refreshing')
              : t('app.providers.notChecked')}
          </p>
        }
      >
        {(detected) => (
          <dl class="app-facts">
            <dt>{isCli() ? t('app.providers.installed') : t('app.providers.reachable')}</dt>
            <dd>
              <Show
                when={detected().installed}
                fallback={<span class="app-badge is-bad">{t('app.no')}</span>}
              >
                <span class="app-badge is-ok">{t('app.yes')}</span>{' '}
                <Show when={detected().version}>
                  {(version) => t('app.providers.version', { version: version() })}
                </Show>
              </Show>
            </dd>
            <dt>{t('app.providers.login.label')}</dt>
            <dd>
              <span
                class="app-badge"
                classList={{
                  'is-ok': detected().loggedIn === 'yes',
                  'is-bad': detected().loggedIn === 'no',
                  'is-warn': detected().loggedIn === 'unknown',
                }}
              >
                {t(LOGIN_KEYS[detected().loggedIn])}
              </span>
            </dd>
            <dt>{t('app.providers.billing.label')}</dt>
            <dd>{t(BILLING_KEYS[detected().billing ?? 'unknown'])}</dd>
            <dt>{t('app.providers.streaming.label')}</dt>
            <dd>{t(STREAMING_KEYS[detected().streaming])}</dd>
            <Show when={props.status?.detectedAt}>
              {(at) => (
                <>
                  <dt>{t('app.providers.checkedAt')}</dt>
                  <dd>{formatDateTime(at(), i18n.language())}</dd>
                </>
              )}
            </Show>
          </dl>
        )}
      </Show>
      <Show when={detection()?.hint}>{(hint) => <p class="app-muted">{hint()}</p>}</Show>

      <Show when={props.status}>
        {(status) => (
          <p class="app-muted">
            {t('app.providers.tools.label')} {t(TOOL_KEYS[status().toolAccess])}
          </p>
        )}
      </Show>

      <Show when={props.status?.loginCommand}>
        {(command) => (
          <div class="app-field">
            <span class="app-label">{t('app.providers.loginCommand.title')}</span>
            <span class="app-muted">
              {t(
                meta()?.mode === 'desktop'
                  ? 'app.providers.loginCommand.helpDesktop'
                  : 'app.providers.loginCommand.help',
              )}
            </span>
            <div class="app-row">
              <code class="app-code">{command()}</code>
              <CopyButton text={command()} label={t('app.providers.loginCommand.copy')} />
              <Show when={isCli() && bridge()}>
                <button
                  type="button"
                  class="app-button"
                  disabled={openingTerminal()}
                  aria-label={t('app.providers.loginTerminal.openOne', {
                    label: props.instance.label,
                  })}
                  onClick={() => void openLoginTerminal()}
                >
                  {t('app.providers.loginTerminal.open')}
                </button>
              </Show>
            </div>
          </div>
        )}
      </Show>

      <Show when={KINDS_REQUIRING_ACKNOWLEDGEMENT.includes(props.instance.kind)}>
        <p class="app-muted">{t('app.providers.risk.note')}</p>
      </Show>

      <div class="app-fields">
        <div class="app-field">
          <label for={ids.concurrency}>{t('app.providers.concurrency.label')}</label>
          <input
            id={ids.concurrency}
            class="app-input is-narrow"
            type="number"
            inputMode="numeric"
            min={bounds().min}
            max={bounds().max}
            step={1}
            value={props.instance.concurrency}
            disabled={props.disabled || bounds().min === bounds().max}
            aria-invalid={concurrencyInvalid()}
            aria-describedby={`${ids.concurrency}-help`}
            onChange={(event) => changeConcurrency(event.currentTarget.value)}
          />
          <span id={`${ids.concurrency}-help`} class="app-muted">
            {bounds().min === bounds().max
              ? t('app.providers.concurrency.fixed', { value: bounds().min })
              : t('app.providers.concurrency.help', { min: bounds().min, max: bounds().max })}
          </span>
        </div>

        <Show when={props.instance.kind !== 'openai-compat' && props.instance}>
          {(cli) => (
            <div class="app-field">
              <div class="app-check">
                <input
                  id={ids.envKey}
                  type="checkbox"
                  checked={cli().useEnvApiKey}
                  disabled={props.disabled}
                  aria-describedby={`${ids.envKey}-help`}
                  onChange={(event) =>
                    requestToggle(event.currentTarget, cli().useEnvApiKey, (useEnvApiKey) => {
                      void props.onChange({ ...cli(), useEnvApiKey });
                    })
                  }
                />
                <label for={ids.envKey}>{t('app.providers.envKey.label')}</label>
              </div>
              <span id={`${ids.envKey}-help`} class="app-muted">
                {t('app.providers.envKey.help')}
              </span>
            </div>
          )}
        </Show>

        <Show
          when={
            props.status?.webSearch === 'available' &&
            props.instance.kind !== 'openai-compat' &&
            props.instance
          }
        >
          {(cli) => (
            <div class="app-field">
              <div class="app-check">
                <input
                  id={ids.webSearch}
                  type="checkbox"
                  checked={cli().webSearch}
                  disabled={props.disabled}
                  aria-describedby={`${ids.webSearch}-help`}
                  onChange={(event) =>
                    requestToggle(event.currentTarget, cli().webSearch, (webSearch) => {
                      void props.onChange({ ...cli(), webSearch });
                    })
                  }
                />
                <label for={ids.webSearch}>{t('app.providers.webSearch.label')}</label>
              </div>
              <span id={`${ids.webSearch}-help`} class="app-muted">
                {t('app.providers.webSearch.help')}
              </span>
            </div>
          )}
        </Show>
      </div>

      <Show when={props.status?.webSearch === 'unconfirmed'}>
        <p class="app-muted">{t('app.providers.webSearch.unconfirmed')}</p>
      </Show>

      <ModelsEditor
        instance={input()}
        available={props.status?.models ?? []}
        disabled={props.disabled}
        onChange={(next) => props.onChange(next)}
      />

      <div class="app-actions">
        <button
          type="button"
          class="app-button"
          disabled={props.disabled}
          aria-label={t('app.providers.refreshOne', { label: props.instance.label })}
          onClick={() => props.onRefresh()}
        >
          {t('app.providers.refresh')}
        </button>
        <Show when={props.onEdit}>
          <button
            type="button"
            class="app-button"
            disabled={props.disabled}
            aria-label={t('app.providers.endpoint.editOne', { label: props.instance.label })}
            onClick={() => props.onEdit?.()}
          >
            {t('app.edit')}
          </button>
        </Show>
        <Show when={props.onRemove}>
          <button
            type="button"
            class="app-button is-danger"
            disabled={props.disabled}
            aria-label={t('app.providers.endpoint.removeOne', { label: props.instance.label })}
            onClick={() => props.onRemove?.()}
          >
            {t('app.remove')}
          </button>
        </Show>
      </div>

      <Show when={acknowledging()}>
        <AcknowledgeDialog
          label={props.instance.label}
          onConfirm={acknowledge}
          onCancel={() => setAcknowledging(false)}
        />
      </Show>
    </section>
  );
};
