import { createSignal, createUniqueId, For, onMount, Show } from 'solid-js';
import type { Component } from 'solid-js';
import { PAIRING_MAX_ATTEMPTS } from '@answerwall/core/protocol';
import type { Device } from '@answerwall/core/protocol';
import { Dialog } from '../../app/ui/Dialog.tsx';
import { formatDateTime, formatTime } from '../../app/ui/format.ts';
import { useServices } from '../../contracts/services.ts';
import { createDevicesStore } from '../../infra/devices-store.ts';

export interface DevicesSectionProps {
  /** Ends this device's session on the server. Rejects with `ApiError`. */
  onLogout(): Promise<void>;
  /** This device's own access was revoked. */
  onSignedOut(): void;
}

/** The paired devices: revoke one, pair another with a one-time code, sign this one out. */
export const DevicesSection: Component<DevicesSectionProps> = (props) => {
  const { api, notify, i18n } = useServices();
  const t = i18n.t;
  const titleId = createUniqueId();
  const store = createDevicesStore(api);
  const [revoking, setRevoking] = createSignal<Device>();
  const [busy, setBusy] = createSignal(false);

  const when = (timestamp: number) => formatDateTime(timestamp, i18n.language());
  const full = () => {
    const max = store.maxDevices();
    return max !== undefined && (store.devices()?.length ?? 0) >= max;
  };

  /** Follows one request: the buttons are disabled while it runs and a failure is reported. */
  async function run(request: Promise<void>): Promise<void> {
    setBusy(true);
    try {
      await request;
    } catch (error) {
      notify.reportError(error);
    } finally {
      setBusy(false);
    }
  }

  onMount(() => void run(store.load()));

  async function revokeNow(device: Device): Promise<void> {
    await store.revoke(device.id);
    if (device.current) props.onSignedOut();
    else notify.toast({ kind: 'success', message: t('app.settings.devices.revoked') });
  }

  function revoke(device: Device): Promise<void> {
    setRevoking(undefined);
    return run(revokeNow(device));
  }

  return (
    <section class="app-card" aria-labelledby={titleId}>
      <h2 id={titleId}>{t('app.settings.devices.title')}</h2>
      <Show when={store.devices()} fallback={<p class="app-muted">{t('app.loading')}</p>}>
        {(devices) => (
          <>
            <p class="app-muted">
              {t('app.settings.devices.count', {
                count: devices().length,
                max: store.maxDevices() ?? '',
              })}
            </p>
            <ul class="app-list">
              <For each={devices()}>
                {(device) => (
                  <li>
                    <span>
                      <strong>{device.name}</strong>{' '}
                      <Show when={device.current}>
                        <span class="app-badge is-ok">{t('app.settings.devices.current')}</span>
                      </Show>
                      <br />
                      <span class="app-muted">
                        {t('app.settings.devices.paired', { date: when(device.createdAt) })}
                        {' · '}
                        {device.lastUsedAt === null
                          ? t('app.settings.devices.neverUsed')
                          : t('app.settings.devices.lastUsed', { date: when(device.lastUsedAt) })}
                      </span>
                    </span>
                    <button
                      type="button"
                      class="app-button is-danger"
                      disabled={busy()}
                      aria-label={t('app.settings.devices.revokeOne', { name: device.name })}
                      onClick={() => setRevoking(device)}
                    >
                      {t('app.settings.devices.revoke')}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </Show>

      <h3>{t('app.settings.devices.pairTitle')}</h3>
      <p class="app-muted">
        {t('app.settings.devices.pairHelp', { attempts: PAIRING_MAX_ATTEMPTS })}
      </p>
      <Show when={full()}>
        <p class="app-error">{t('app.settings.devices.full')}</p>
      </Show>
      <div class="app-actions">
        <button
          type="button"
          class="app-button"
          disabled={busy() || full()}
          onClick={() => void run(store.createPairingCode())}
        >
          {t('app.settings.devices.createCode')}
        </button>
      </div>
      <Show when={store.pairingCode()}>
        {(code) => (
          <p role="status">
            <span class="app-pairing-code">{code().code}</span>
            <br />
            <span class="app-muted">
              {t('app.settings.devices.codeExpires', {
                time: formatTime(code().expiresAt, i18n.language()),
              })}
            </span>
          </p>
        )}
      </Show>

      <h3>{t('app.settings.devices.thisDevice')}</h3>
      <div class="app-actions">
        <button
          type="button"
          class="app-button"
          disabled={busy()}
          onClick={() => void run(props.onLogout())}
        >
          {t('app.settings.devices.signOut')}
        </button>
      </div>

      <Show when={revoking()}>
        {(device) => (
          <Dialog
            title={t('app.settings.devices.revokeTitle', { name: device().name })}
            onClose={() => setRevoking(undefined)}
            actions={
              <>
                <button type="button" class="app-button" onClick={() => setRevoking(undefined)}>
                  {t('app.cancel')}
                </button>
                <button
                  type="button"
                  class="app-button is-danger"
                  onClick={() => void revoke(device())}
                >
                  {t('app.settings.devices.revoke')}
                </button>
              </>
            }
          >
            <p>
              {device().current
                ? t('app.settings.devices.revokeCurrentBody')
                : t('app.settings.devices.revokeBody')}
            </p>
          </Dialog>
        )}
      </Show>
    </section>
  );
};
