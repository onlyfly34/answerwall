import { createSignal, createUniqueId, For, Show } from 'solid-js';
import type { Component } from 'solid-js';
import {
  concurrencyBounds,
  DEFAULT_WEB_CELLS,
  ExtensionIdSchema,
  MAX_EXTENSION_IDS,
  MAX_PROVIDER_INSTANCES,
  WEB_SITES,
  webProviderId,
} from '@answerwall/core/protocol';
import type {
  ProviderInstanceInput,
  SettingsPatch,
  WebCellsSettings,
  WebSiteId,
} from '@answerwall/core/protocol';
import type { MessageKey } from '../../contracts/messages.ts';
import { useServices } from '../../contracts/services.ts';
import { withProvider } from '../providers/provider-edits.ts';

type Switch = 'enabled' | 'fillPrompt' | 'readAnswer';

const SWITCHES: readonly { name: Switch; label: MessageKey; help: MessageKey }[] = [
  {
    name: 'enabled',
    label: 'app.settings.webCells.enabled',
    help: 'app.settings.webCells.enabledHelp',
  },
  {
    name: 'fillPrompt',
    label: 'app.settings.webCells.fillPrompt',
    help: 'app.settings.webCells.fillPromptHelp',
  },
  {
    name: 'readAnswer',
    label: 'app.settings.webCells.readAnswer',
    help: 'app.settings.webCells.readAnswerHelp',
  },
];

/**
 * Web cells: the master switch, the two things the extension may do on a
 * site, the extensions that may connect, and the sites offered. Everything is
 * off in a fresh installation, and each change is saved at once.
 */
export const WebCellsSection: Component<{ save(patch: SettingsPatch): Promise<boolean> }> = (
  props,
) => {
  const { settings, i18n } = useServices();
  const t = i18n.t;
  const titleId = createUniqueId();
  const idField = createUniqueId();
  const [newId, setNewId] = createSignal('');
  const [invalid, setInvalid] = createSignal(false);

  const webCells = (): WebCellsSettings => settings.settings()?.webCells ?? DEFAULT_WEB_CELLS;
  const instances = () => settings.settings()?.providers ?? [];
  const instanceOf = (site: WebSiteId) =>
    instances().find((instance) => instance.id === webProviderId(site));
  const listFull = () => webCells().extensionIds.length >= MAX_EXTENSION_IDS;

  async function addExtension(): Promise<void> {
    const id = ExtensionIdSchema.safeParse(newId().trim());
    setInvalid(!id.success);
    if (!id.success) return;
    const current = webCells().extensionIds;
    if (!current.includes(id.data)) {
      if (!(await props.save({ webCells: { extensionIds: [...current, id.data] } }))) return;
    }
    setNewId('');
  }

  function removeExtension(id: string): void {
    void props.save({
      webCells: { extensionIds: webCells().extensionIds.filter((other) => other !== id) },
    });
  }

  function toggleSite(site: (typeof WEB_SITES)[number], enabled: boolean): void {
    const existing = instanceOf(site.id);
    const next: ProviderInstanceInput =
      existing?.kind === 'web'
        ? { ...existing, enabled }
        : {
            id: webProviderId(site.id),
            kind: 'web',
            site: site.id,
            label: site.label,
            enabled,
            concurrency: concurrencyBounds('web').default,
            models: [],
          };
    void props.save({ providers: withProvider(instances(), next) });
  }

  return (
    <section class="app-card" aria-labelledby={titleId}>
      <h2 id={titleId}>{t('app.settings.webCells.title')}</h2>
      <p class="app-muted">{t('app.settings.webCells.intro')}</p>
      <p>{t('app.settings.webCells.terms')}</p>

      <For each={SWITCHES}>
        {(item) => {
          const id = createUniqueId();
          return (
            <div class="app-field">
              <div class="app-check">
                <input
                  id={id}
                  type="checkbox"
                  checked={webCells()[item.name]}
                  aria-describedby={`${id}-help`}
                  onChange={(event) =>
                    void props.save({ webCells: { [item.name]: event.currentTarget.checked } })
                  }
                />
                <label for={id}>{t(item.label)}</label>
              </div>
              <span id={`${id}-help`} class="app-muted">
                {t(item.help)}
              </span>
            </div>
          );
        }}
      </For>

      <h3>{t('app.settings.webCells.extensions.title')}</h3>
      <p class="app-muted">{t('app.settings.webCells.extensions.help')}</p>
      <Show
        when={webCells().extensionIds.length > 0}
        fallback={<p class="app-muted">{t('app.settings.webCells.extensions.none')}</p>}
      >
        <ul class="app-list">
          <For each={webCells().extensionIds}>
            {(id) => (
              <li>
                <code>{id}</code>
                <button
                  type="button"
                  class="app-button is-danger"
                  aria-label={t('app.settings.webCells.extensions.remove', { id })}
                  onClick={() => removeExtension(id)}
                >
                  {t('app.remove')}
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <form
        class="app-field"
        onSubmit={(event) => {
          event.preventDefault();
          void addExtension();
        }}
      >
        <label for={idField}>{t('app.settings.webCells.extensions.label')}</label>
        <div class="app-actions">
          <input
            id={idField}
            class="app-input"
            type="text"
            autocomplete="off"
            spellcheck={false}
            maxLength={32}
            value={newId()}
            disabled={listFull()}
            aria-invalid={invalid()}
            aria-describedby={`${idField}-help`}
            onInput={(event) => {
              setNewId(event.currentTarget.value);
              setInvalid(false);
            }}
          />
          <button type="submit" class="app-button" disabled={listFull() || newId().trim() === ''}>
            {t('app.add')}
          </button>
        </div>
        <span
          id={`${idField}-help`}
          classList={{ 'app-muted': !invalid(), 'app-error': invalid() }}
        >
          {listFull()
            ? t('app.settings.webCells.extensions.full', { max: MAX_EXTENSION_IDS })
            : t('app.settings.webCells.extensions.invalid')}
        </span>
      </form>

      <h3>{t('app.settings.webCells.sites.title')}</h3>
      <p class="app-muted">{t('app.settings.webCells.sites.help')}</p>
      <For each={WEB_SITES}>
        {(site) => {
          const id = createUniqueId();
          const instance = () => instanceOf(site.id);
          // The id may belong to an endpoint the user named that way; then the site cannot be added.
          const taken = () => instance() !== undefined && instance()?.kind !== 'web';
          const full = () =>
            instance() === undefined && instances().length >= MAX_PROVIDER_INSTANCES;
          return (
            <div class="app-check">
              <input
                id={id}
                type="checkbox"
                checked={instance()?.kind === 'web' && instance()?.enabled === true}
                disabled={taken() || full()}
                onChange={(event) => toggleSite(site, event.currentTarget.checked)}
              />
              <label for={id}>
                {instance()?.kind === 'web' ? instance()?.label : site.label}{' '}
                <span class="app-muted">({site.host})</span>
              </label>
            </div>
          );
        }}
      </For>
    </section>
  );
};
