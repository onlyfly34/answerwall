import { createMemo, createSignal, For, Show } from 'solid-js';
import type { Component } from 'solid-js';
import { A } from '@solidjs/router';
import { BRAND, isCliKind, MAX_PROVIDER_INSTANCES } from '@answerwall/core/protocol';
import type {
  OpenAiCompatInstance,
  ProviderInstance,
  ProviderInstanceInput,
} from '@answerwall/core/protocol';
import { Dialog } from '../../app/ui/Dialog.tsx';
import { ROUTES } from '../../contracts/routes.ts';
import { useServices } from '../../contracts/services.ts';
import { EndpointDialog } from './EndpointDialog.tsx';
import { ProviderCard } from './ProviderCard.tsx';
import { withoutProvider, withProvider } from './provider-edits.ts';

/** `new`: the add dialog. Otherwise the endpoint being edited. */
type Editing = 'new' | OpenAiCompatInstance | undefined;

/**
 * Every provider: what was detected on the server, how to sign in to it, and
 * its configuration. Each change is saved at once. Detection runs only when
 * the user presses a refresh button.
 */
export const ProvidersPage: Component = () => {
  const { meta, settings, providers, notify, i18n } = useServices();
  const t = i18n.t;
  const [saving, setSaving] = createSignal(false);
  /** Bumped by a refused save: the cards are rebuilt so their controls show the stored values again. */
  const [generation, setGeneration] = createSignal(1);
  const [editing, setEditing] = createSignal<Editing>();
  const [removing, setRemoving] = createSignal<ProviderInstance>();

  const instances = (): ProviderInstance[] => settings.settings()?.providers ?? [];
  const find = (id: string) => {
    const instance = instances().find((candidate) => candidate.id === id);
    // Web providers have no card here: they are part of the web cells settings.
    return instance?.kind === 'web' ? undefined : instance;
  };
  // Cards are keyed by id, so saving one does not rebuild (and unfocus) the others.
  const cliIds = createMemo(() =>
    instances()
      .filter((instance) => isCliKind(instance.kind))
      .map((instance) => instance.id),
  );
  const endpointIds = createMemo(() =>
    instances()
      .filter((instance) => instance.kind === 'openai-compat')
      .map((instance) => instance.id),
  );
  const statusOf = (id: string) =>
    providers.providers().find((status) => status.instance.id === id);
  const busy = () => saving() || providers.busy();

  async function saveList(next: ProviderInstanceInput[]): Promise<boolean> {
    setSaving(true);
    try {
      await settings.update({ providers: next });
      return true;
    } catch (error) {
      notify.reportError(error);
      setGeneration((current) => current + 1);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const save = (next: ProviderInstanceInput) => saveList(withProvider(instances(), next));

  function refresh(providerId?: string): void {
    providers.refresh(providerId).catch((error: unknown) => notify.reportError(error));
  }

  async function saveEndpoint(endpoint: ProviderInstanceInput): Promise<boolean> {
    const saved = await save(endpoint);
    if (saved) notify.toast({ kind: 'success', message: t('app.saved') });
    return saved;
  }

  async function remove(instance: ProviderInstance): Promise<void> {
    setRemoving(undefined);
    if (await saveList(withoutProvider(instances(), instance.id))) {
      notify.toast({
        kind: 'success',
        message: t('app.providers.endpoint.removed', { label: instance.label }),
      });
    }
  }

  const card = (id: string, endpoint: boolean) => (
    // Rebuilt only when the generation changes; a successful save updates the card in place.
    <Show when={generation()} keyed>
      {(_generation) => (
        <Show when={find(id)}>
          {(instance) => (
            <ProviderCard
              instance={instance()}
              status={statusOf(id)}
              disabled={busy()}
              onChange={save}
              onRefresh={() => refresh(id)}
              {...(endpoint
                ? {
                    onEdit: () => {
                      const current = instance();
                      if (current.kind === 'openai-compat') setEditing(current);
                    },
                    onRemove: () => setRemoving(instance()),
                  }
                : {})}
            />
          )}
        </Show>
      )}
    </Show>
  );

  return (
    <div class="app-page">
      <div class="app-card-header">
        <h1>{t('app.providers.title')}</h1>
        <button
          type="button"
          class="app-button"
          disabled={busy()}
          aria-busy={providers.busy()}
          onClick={() => refresh()}
        >
          {providers.busy() ? t('app.providers.refreshing') : t('app.providers.refreshAll')}
        </button>
      </div>
      <p class="app-muted">{t('app.providers.intro')}</p>

      <h2>{t('app.providers.cliTitle')}</h2>
      <For each={cliIds()}>{(id) => card(id, false)}</For>

      <div class="app-card-header">
        <h2>{t('app.providers.endpoint.title')}</h2>
        <button
          type="button"
          class="app-button"
          disabled={busy() || instances().length >= MAX_PROVIDER_INSTANCES}
          onClick={() => setEditing('new')}
        >
          {t('app.providers.endpoint.add')}
        </button>
      </div>
      <p class="app-muted">{t('app.providers.endpoint.intro')}</p>
      <Show when={endpointIds().length === 0}>
        <p class="app-muted">{t('app.providers.endpoint.none')}</p>
      </Show>
      <For each={endpointIds()}>{(id) => card(id, true)}</For>

      {/* Web cells need a browser extension paired as a device, which the desktop app does not have. */}
      <Show when={meta()?.mode !== 'desktop'}>
        <section aria-labelledby="providers-web-cells">
          <h2 id="providers-web-cells">{t('app.providers.webCells.title')}</h2>
          <p class="app-muted">{t('app.providers.webCells.intro')}</p>
          <ol class="app-steps">
            <li>
              {t('app.providers.webCells.stepGet')}{' '}
              <a href={`${BRAND.repository}/releases`} target="_blank" rel="noreferrer">
                {t('app.providers.webCells.releases')}
              </a>
            </li>
            <li>{t('app.providers.webCells.stepLoad')}</li>
            <li>
              {t('app.providers.webCells.stepAllow')}{' '}
              <A href={ROUTES.settings}>{t('app.providers.webCells.openSettings')}</A>
            </li>
            <li>{t('app.providers.webCells.stepPair')}</li>
          </ol>
          <p class="app-muted">{t('app.providers.webCells.terms')}</p>
        </section>
      </Show>

      <Show when={editing()}>
        {(target) => {
          const existing = target();
          return (
            <EndpointDialog
              initialEndpoint={existing === 'new' ? undefined : existing}
              takenIds={instances().map((instance) => instance.id)}
              onSave={saveEndpoint}
              onClose={() => setEditing(undefined)}
            />
          );
        }}
      </Show>

      <Show when={removing()}>
        {(instance) => (
          <Dialog
            title={t('app.providers.endpoint.removeTitle', { label: instance().label })}
            onClose={() => setRemoving(undefined)}
            actions={
              <>
                <button type="button" class="app-button" onClick={() => setRemoving(undefined)}>
                  {t('app.cancel')}
                </button>
                <button
                  type="button"
                  class="app-button is-danger"
                  onClick={() => void remove(instance())}
                >
                  {t('app.remove')}
                </button>
              </>
            }
          >
            <p>{t('app.providers.endpoint.removeBody')}</p>
          </Dialog>
        )}
      </Show>
    </div>
  );
};
