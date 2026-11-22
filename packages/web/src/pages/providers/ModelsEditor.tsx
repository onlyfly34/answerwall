import { createSignal, createUniqueId, For, Show } from 'solid-js';
import type { Component } from 'solid-js';
import { ModelIdSchema } from '@answerwall/core/protocol';
import type { ModelInfo, ProviderInstanceInput } from '@answerwall/core/protocol';
import { useServices } from '../../contracts/services.ts';
import { addModel, removeModel, setDefaultModel } from './provider-edits.ts';

/** The server refuses longer lists. */
const MAX_MODELS = 200;

export interface ModelsEditorProps {
  instance: ProviderInstanceInput;
  /** The instance's list merged with what the provider itself lists. */
  available: readonly ModelInfo[];
  disabled: boolean;
  onChange(next: ProviderInstanceInput): Promise<boolean>;
}

/** The user's model list for one provider, and which model a cell starts with. */
export const ModelsEditor: Component<ModelsEditorProps> = (props) => {
  const { i18n } = useServices();
  const t = i18n.t;
  const addId = createUniqueId();
  const defaultId = createUniqueId();
  const [draft, setDraft] = createSignal('');
  const [invalid, setInvalid] = createSignal(false);

  /** Everything that can be the default: listed by the provider or added by the user. */
  const choices = (): string[] => [
    ...new Set([...props.available.map((model) => model.id), ...props.instance.models]),
  ];

  async function add(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const parsed = ModelIdSchema.safeParse(draft());
    if (!parsed.success || props.instance.models.length >= MAX_MODELS) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (await props.onChange(addModel(props.instance, parsed.data))) setDraft('');
  }

  return (
    <div class="app-form">
      <div class="app-field">
        <span class="app-label">{t('app.providers.models.title')}</span>
        <Show
          when={props.instance.models.length > 0}
          fallback={<span class="app-muted">{t('app.providers.models.empty')}</span>}
        >
          <ul class="app-list">
            <For each={props.instance.models}>
              {(model) => (
                <li>
                  <code>{model}</code>
                  <button
                    type="button"
                    class="app-button"
                    disabled={props.disabled}
                    aria-label={t('app.providers.models.remove', { model })}
                    onClick={() => void props.onChange(removeModel(props.instance, model))}
                  >
                    {t('app.remove')}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
      <form class="app-field" noValidate onSubmit={(event) => void add(event)}>
        <label for={addId}>{t('app.providers.models.add')}</label>
        <div class="app-row">
          <input
            id={addId}
            class="app-input is-grow"
            autocomplete="off"
            maxLength={200}
            value={draft()}
            aria-invalid={invalid()}
            onInput={(event) => setDraft(event.currentTarget.value)}
          />
          <button type="submit" class="app-button" disabled={props.disabled}>
            {t('app.add')}
          </button>
        </div>
        <Show when={invalid()}>
          <span class="app-error">{t('app.providers.models.invalid')}</span>
        </Show>
      </form>
      <div class="app-field">
        <label for={defaultId}>{t('app.providers.models.default')}</label>
        <select
          id={defaultId}
          class="app-input"
          disabled={props.disabled}
          onChange={(event) =>
            void props.onChange(
              setDefaultModel(props.instance, event.currentTarget.value || undefined),
            )
          }
        >
          <option value="" selected={props.instance.defaultModel === undefined}>
            {t('app.providers.models.providerDefault')}
          </option>
          <For each={choices()}>
            {(model) => (
              <option value={model} selected={props.instance.defaultModel === model}>
                {model}
              </option>
            )}
          </For>
        </select>
      </div>
    </div>
  );
};
