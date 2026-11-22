import { createSignal, createUniqueId, Show } from 'solid-js';
import type { Component } from 'solid-js';
import {
  CLI_PROVIDER_KINDS,
  concurrencyBounds,
  ProviderInstanceInputSchema,
} from '@answerwall/core/protocol';
import type { OpenAiCompatInstance, ProviderInstanceInput } from '@answerwall/core/protocol';
import { Dialog } from '../../app/ui/Dialog.tsx';
import type { MessageKey } from '../../contracts/messages.ts';
import { useServices } from '../../contracts/services.ts';
import { slugify } from './provider-edits.ts';

type FieldName = 'label' | 'id' | 'baseUrl' | 'apiKey' | 'concurrency';

const FIELD_ERRORS: Record<FieldName, MessageKey> = {
  label: 'app.providers.endpoint.error.label',
  id: 'app.providers.endpoint.error.id',
  baseUrl: 'app.providers.endpoint.error.baseUrl',
  apiKey: 'app.providers.endpoint.error.apiKey',
  concurrency: 'app.providers.endpoint.error.concurrency',
};
const FIELDS = Object.keys(FIELD_ERRORS) as FieldName[];

export interface EndpointDialogProps {
  /** The endpoint being edited; absent when adding one. */
  initialEndpoint?: OpenAiCompatInstance | undefined;
  /** Ids that a new endpoint may not take. */
  takenIds: readonly string[];
  /** Saves; resolves whether the server accepted it. */
  onSave(endpoint: ProviderInstanceInput): Promise<boolean>;
  onClose(): void;
}

/**
 * Adds or edits an OpenAI-compatible endpoint. The API key is write-only:
 * the stored one is never shown, only replaced or deleted.
 */
export const EndpointDialog: Component<EndpointDialogProps> = (props) => {
  const { i18n } = useServices();
  const t = i18n.t;
  const existing = props.initialEndpoint;
  const bounds = concurrencyBounds('openai-compat');
  const formId = createUniqueId();
  const ids = Object.fromEntries(FIELDS.map((field) => [field, createUniqueId()])) as Record<
    FieldName,
    string
  >;
  const deleteKeyId = createUniqueId();

  const [label, setLabel] = createSignal(existing?.label ?? '');
  const [id, setId] = createSignal(existing?.id ?? '');
  /** Until the id is typed by hand it follows the label. */
  const [idEdited, setIdEdited] = createSignal(existing !== undefined);
  const [baseUrl, setBaseUrl] = createSignal(existing?.baseUrl ?? '');
  const [apiKey, setApiKey] = createSignal('');
  const [deleteKey, setDeleteKey] = createSignal(false);
  const [concurrency, setConcurrency] = createSignal(
    String(existing?.concurrency ?? bounds.default),
  );
  const [errors, setErrors] = createSignal<FieldName[]>([]);
  const [saving, setSaving] = createSignal(false);

  function build(): ProviderInstanceInput | undefined {
    const key = apiKey();
    const candidate = {
      kind: 'openai-compat',
      id: id(),
      label: label(),
      enabled: existing?.enabled ?? true,
      concurrency: Number(concurrency()),
      models: existing?.models ?? [],
      ...(existing?.defaultModel === undefined ? {} : { defaultModel: existing.defaultModel }),
      baseUrl: baseUrl().trim(),
      // Omitted keeps the stored key, `null` deletes it, a string replaces it.
      ...(key !== '' ? { apiKey: key } : deleteKey() ? { apiKey: null } : {}),
    };
    const parsed = ProviderInstanceInputSchema.safeParse(candidate);
    const failed = new Set<FieldName>();
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = FIELDS.find((name) => name === issue.path[0]);
        if (field) failed.add(field);
      }
    }
    const reserved: readonly string[] = CLI_PROVIDER_KINDS;
    if (!existing && (props.takenIds.includes(id()) || reserved.includes(id()))) failed.add('id');
    setErrors([...failed]);
    return parsed.success && failed.size === 0 ? parsed.data : undefined;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving()) return;
    const endpoint = build();
    if (!endpoint) {
      const first = FIELDS.find((field) => errors().includes(field));
      if (first) document.getElementById(ids[first])?.focus();
      return;
    }
    setSaving(true);
    try {
      if (await props.onSave(endpoint)) props.onClose();
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (field: FieldName) => (
    <Show when={errors().includes(field)}>
      <span id={`${ids[field]}-error`} class="app-error">
        {t(FIELD_ERRORS[field], { min: bounds.min, max: bounds.max })}
      </span>
    </Show>
  );
  const describedBy = (field: FieldName, help?: string) =>
    [errors().includes(field) ? `${ids[field]}-error` : undefined, help]
      .filter((part) => part !== undefined)
      .join(' ') || undefined;

  return (
    <Dialog
      title={
        existing ? t('app.providers.endpoint.editTitle') : t('app.providers.endpoint.addTitle')
      }
      onClose={() => props.onClose()}
      actions={
        <>
          <button type="button" class="app-button" onClick={() => props.onClose()}>
            {t('app.cancel')}
          </button>
          <button type="submit" form={formId} class="app-button is-primary" disabled={saving()}>
            {t('app.save')}
          </button>
        </>
      }
    >
      <form id={formId} class="app-form" noValidate onSubmit={(event) => void submit(event)}>
        <div class="app-field">
          <label for={ids.label}>{t('app.providers.endpoint.label')}</label>
          <input
            id={ids.label}
            class="app-input"
            autocomplete="off"
            maxLength={64}
            value={label()}
            aria-invalid={errors().includes('label')}
            aria-describedby={describedBy('label')}
            onInput={(event) => {
              setLabel(event.currentTarget.value);
              if (!idEdited()) setId(slugify(event.currentTarget.value));
            }}
          />
          {fieldError('label')}
        </div>
        <div class="app-field">
          <label for={ids.id}>{t('app.providers.endpoint.id')}</label>
          <input
            id={ids.id}
            class="app-input"
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            maxLength={32}
            value={id()}
            readOnly={existing !== undefined}
            aria-invalid={errors().includes('id')}
            aria-describedby={describedBy('id', `${ids.id}-help`)}
            onInput={(event) => {
              setIdEdited(true);
              setId(event.currentTarget.value);
            }}
          />
          {fieldError('id')}
          <span id={`${ids.id}-help`} class="app-muted">
            {existing ? t('app.providers.endpoint.idFixed') : t('app.providers.endpoint.idHelp')}
          </span>
        </div>
        <div class="app-field">
          <label for={ids.baseUrl}>{t('app.providers.endpoint.baseUrl')}</label>
          <input
            id={ids.baseUrl}
            class="app-input"
            type="url"
            inputMode="url"
            autocomplete="off"
            placeholder="https://"
            value={baseUrl()}
            aria-invalid={errors().includes('baseUrl')}
            aria-describedby={describedBy('baseUrl', `${ids.baseUrl}-help`)}
            onInput={(event) => setBaseUrl(event.currentTarget.value)}
          />
          {fieldError('baseUrl')}
          <span id={`${ids.baseUrl}-help`} class="app-muted">
            {t('app.providers.endpoint.baseUrlHelp')}
          </span>
        </div>
        <div class="app-field">
          <label for={ids.apiKey}>{t('app.providers.endpoint.apiKey')}</label>
          <input
            id={ids.apiKey}
            class="app-input"
            type="password"
            autocomplete="new-password"
            value={apiKey()}
            disabled={deleteKey()}
            aria-invalid={errors().includes('apiKey')}
            aria-describedby={describedBy('apiKey', `${ids.apiKey}-help`)}
            onInput={(event) => setApiKey(event.currentTarget.value)}
          />
          {fieldError('apiKey')}
          <span id={`${ids.apiKey}-help`} class="app-muted">
            {existing?.hasApiKey
              ? t('app.providers.endpoint.apiKeyKeep')
              : t('app.providers.endpoint.apiKeyHelp')}
          </span>
          <Show when={existing?.hasApiKey}>
            <div class="app-check">
              <input
                id={deleteKeyId}
                type="checkbox"
                checked={deleteKey()}
                onChange={(event) => {
                  setDeleteKey(event.currentTarget.checked);
                  if (event.currentTarget.checked) setApiKey('');
                }}
              />
              <label for={deleteKeyId}>{t('app.providers.endpoint.apiKeyDelete')}</label>
            </div>
          </Show>
        </div>
        <div class="app-field">
          <label for={ids.concurrency}>{t('app.providers.concurrency.label')}</label>
          <input
            id={ids.concurrency}
            class="app-input is-narrow"
            type="number"
            inputMode="numeric"
            min={bounds.min}
            max={bounds.max}
            step={1}
            value={concurrency()}
            aria-invalid={errors().includes('concurrency')}
            aria-describedby={describedBy('concurrency')}
            onInput={(event) => setConcurrency(event.currentTarget.value)}
          />
          {fieldError('concurrency')}
        </div>
      </form>
    </Dialog>
  );
};
