import { createEffect, createSignal, createUniqueId, For, on, Show } from 'solid-js';
import type { Component } from 'solid-js';
import { DEFAULT_LIMITS } from '@answerwall/core/protocol';
import type { LimitName, SettingsPatch } from '@answerwall/core/protocol';
import { useServices } from '../../contracts/services.ts';
import { displayBounds, LIMIT_FIELDS, parseLimits, toDisplay } from './limits-form.ts';
import type { LimitError, LimitsText } from './limits-form.ts';

/**
 * The safety limits. They exist so that a bug or a leaked token cannot fan
 * out without bound; every one has a hard range the server enforces too.
 */
export const LimitsSection: Component<{ save(patch: SettingsPatch): Promise<boolean> }> = (
  props,
) => {
  const { settings, notify, i18n } = useServices();
  const t = i18n.t;
  const titleId = createUniqueId();
  const baseId = createUniqueId();
  const [text, setText] = createSignal<LimitsText>(toDisplay(DEFAULT_LIMITS));
  const [errors, setErrors] = createSignal<Partial<Record<LimitName, LimitError>>>({});
  const [saving, setSaving] = createSignal(false);

  // The form follows the saved limits: on load and after every save, here or on another device.
  createEffect(
    on(
      () => settings.settings()?.limits,
      (limits) => {
        if (limits) setText(toDisplay(limits));
      },
    ),
  );

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving()) return;
    const result = parseLimits(text());
    if (!result.ok) {
      setErrors(result.errors);
      const first = LIMIT_FIELDS.find((field) => result.errors[field.name]);
      if (first) document.getElementById(`${baseId}-${first.name}`)?.focus();
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      if (await props.save({ limits: result.limits })) {
        notify.toast({ kind: 'success', message: t('app.saved') });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section class="app-card" aria-labelledby={titleId}>
      <h2 id={titleId}>{t('app.settings.limits.title')}</h2>
      <p class="app-muted">{t('app.settings.limits.intro')}</p>
      <form class="app-form" noValidate onSubmit={(event) => void submit(event)}>
        <div class="app-fields">
          <For each={LIMIT_FIELDS}>
            {({ name, unit }) => {
              const bounds = displayBounds(name);
              const inputId = `${baseId}-${name}`;
              return (
                <div class="app-field">
                  <label for={inputId}>
                    {t(`app.settings.limits.${name}`)} ({t(`app.settings.unit.${unit}`)})
                  </label>
                  <input
                    id={inputId}
                    class="app-input"
                    type="number"
                    inputMode={unit === 'count' || unit === 'perMinute' ? 'numeric' : 'decimal'}
                    min={bounds.min}
                    max={bounds.max}
                    step={unit === 'count' || unit === 'perMinute' ? 1 : 'any'}
                    value={text()[name]}
                    aria-invalid={errors()[name] !== undefined}
                    aria-describedby={`${inputId}-help`}
                    onInput={(event) => {
                      const value = event.currentTarget.value;
                      setText((current) => ({ ...current, [name]: value }));
                    }}
                  />
                  <span id={`${inputId}-help`}>
                    <Show
                      when={errors()[name]}
                      fallback={
                        <span class="app-muted">
                          {t('app.settings.limits.bounds', { ...bounds })}
                        </span>
                      }
                    >
                      {(error) => (
                        <span class="app-error">
                          {error() === 'promptVsBody'
                            ? t('app.settings.limits.promptVsBody')
                            : t('app.settings.range', { min: bounds.min, max: bounds.max })}
                        </span>
                      )}
                    </Show>
                  </span>
                </div>
              );
            }}
          </For>
        </div>
        <div class="app-actions">
          <button type="submit" class="app-button is-primary" disabled={saving()}>
            {t('app.save')}
          </button>
          <button
            type="button"
            class="app-button"
            disabled={saving()}
            onClick={() => {
              setErrors({});
              setText(toDisplay(DEFAULT_LIMITS));
            }}
          >
            {t('app.settings.limits.defaults')}
          </button>
        </div>
      </form>
    </section>
  );
};
